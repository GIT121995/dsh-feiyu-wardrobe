/**
 * v3 宿主配置/端点：client-config.json = interaction（无 render 开关）+ 版本化资产清单；gzip 仍生效。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { validateConfig, validateDressUpConfig } from '../lib/config.js';
import {
	DRESS_UP_CLIENT_CONFIG,
	DRESS_UP_CONFIG_VERSION,
	DRESS_UP_ENTRY,
	DRESS_UP_INTERACTION_ACTION,
	DRESS_UP_INTERACTION_STATE,
	createDressUpHandler,
	dressUpRoot,
} from '../lib/webserver.js';

const ROOT = dressUpRoot();

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

function makeHandler(options = {}) {
	return createDressUpHandler(ROOT, {
		interaction: {
			enabled: true,
			summary: () => ({ ok: true, coins: 3 }),
			act: () => ({ ok: true }),
		},
		...options,
	});
}

/* ---------------- 配置：去 render 开关 ---------------- */

test('config.dressUp 不再有 render 字段（v2 2.5D-only）', () => {
	const config = validateConfig({ dressUp: { render: 'dom' } });
	assert.deepEqual(Object.keys(config.dressUp), ['interaction']);
	assert.equal('render' in config.dressUp, false);
	assert.equal(config.dressUp.interaction.enabled, true);
	assert.equal(validateConfig({ dressUp: {} }).dressUp.interaction.enabled, true);
	assert.equal(validateConfig({ dressUp: { interaction: { enabled: false } } }).dressUp.interaction.enabled, false);
	// 未知字段忽略
	assert.equal(validateDressUpConfig({ render: '2d5', quality: 'high' }).interaction.enabled, true);
});

/* ---------------- client-config 端点 ---------------- */

test('client-config：版本 4 + interaction（无 render 字段）+ 版本化资产清单（rig.bin + 懒加载页）+ no-store', async () => {
	assert.equal(DRESS_UP_CLIENT_CONFIG, `${DRESS_UP_ENTRY}client-config.json`);
	assert.equal(DRESS_UP_CONFIG_VERSION, 4);
	const handler = makeHandler();
	const res = await hit(handler, DRESS_UP_CLIENT_CONFIG);
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /application\/json/);
	assert.equal(res.headers['cache-control'], 'no-store');
	const body = JSON.parse(String(res.body));
	assert.equal(body.version, 4);
	assert.equal('render' in body, false, 'v2 起不再下发渲染模式');
	assert.deepEqual(body.interaction, {
		enabled: true,
		stateUrl: DRESS_UP_INTERACTION_STATE,
		actionUrl: DRESS_UP_INTERACTION_ACTION,
	});
	// v3.0.1：客户端后台 prefetch 用资产清单（version 来自 app.js 单一真相，shapes 来自 manifest）
	const appSource = readFileSync(join(ROOT, 'app.js'), 'utf8');
	const expectedAsset = appSource.match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'(\d+)'/)[1];
	assert.deepEqual(body.assets, {
		version: expectedAsset,
		base: `${DRESS_UP_ENTRY}art/2d5/`,
		shapes: ['chibi', 'girl'],
		files: {
			lo: ['rig.bin', 'atlas.webp', 'atlas-2.webp', 'atlas-3.webp', 'atlas-4.webp', 'atlas-5.webp'],
			hi: ['rig.bin', 'atlas.webp'],
		},
	});
});

test('client-config：interaction 未启用 → enabled:false；HEAD 无 body；POST 405', async () => {
	const disabled = createDressUpHandler(ROOT, {});
	const res = await hit(disabled, DRESS_UP_CLIENT_CONFIG);
	assert.equal(res.statusCode, 200);
	assert.equal(JSON.parse(String(res.body)).interaction.enabled, false);

	const handler = makeHandler();
	const head = createRes();
	await handler({ method: 'HEAD', url: DRESS_UP_CLIENT_CONFIG, headers: {} }, head);
	assert.equal(head.statusCode, 200);
	assert.equal(head.body, undefined);

	const post = createRes();
	await handler({ method: 'POST', url: DRESS_UP_CLIENT_CONFIG, headers: {} }, post);
	assert.equal(post.statusCode, 405);
});

test('旧的 render-config 端点已删除（404）', async () => {
	const handler = makeHandler();
	const res = await hit(handler, `${DRESS_UP_ENTRY}render-config.json`);
	assert.equal(res.statusCode, 404, 'render-config.json 不再提供（v2 无渲染开关）');
});

test('静态资产与 gzip 不受影响（2.5D rig 首屏仍压缩）', async () => {
	const handler = makeHandler();
	const js = await hit(handler, `${DRESS_UP_ENTRY}app.js`);
	assert.equal(js.statusCode, 200);
	assert.match(js.headers['content-type'], /javascript/);
	const raw = readFileSync(join(ROOT, 'art/2d5/chibi/rig.json'));
	const gz = await hit(handler, `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json`, { 'accept-encoding': 'gzip' });
	assert.equal(gz.headers['content-encoding'], 'gzip');
	const decoded = gunzipSync(gz.body);
	assert.equal(decoded.byteLength, raw.byteLength);
	assert.ok(decoded.equals(raw));
});

test('互动端点保留：client-config 下发地址可访问（GET 状态）', async () => {
	const handler = makeHandler();
	const state = await hit(handler, DRESS_UP_INTERACTION_STATE);
	assert.equal(state.statusCode, 200);
	const body = JSON.parse(String(state.body));
	assert.equal(body.ok, true);
});

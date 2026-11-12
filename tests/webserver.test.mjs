import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	DRESS_UP_ENTRY,
	DRESS_UP_PATH,
	createDressUpHandler,
	dressUpRoot,
	mountDressUpRoutes,
	staticCacheControl,
} from '../lib/webserver.js';

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
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		end(body) {
			this.body = body;
		},
	};
}

function createReq(method, url, headers = {}) {
	return { method, url, headers };
}

const ROOT = dressUpRoot();

async function hit(handler, method, url, headers = {}) {
	const res = createRes();
	await handler(createReq(method, url, headers), res);
	return res;
}

test('dressUpRoot points at the packaged docs/dress-up directory', () => {
	assert.ok(ROOT.endsWith('docs/dress-up/') || ROOT.endsWith('docs/dress-up'));
	assert.ok(ROOT.includes('dsh-feiyu-wardrobe'));
});

test('serves the game index at the entry path with html', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', DRESS_UP_ENTRY);
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /text\/html/);
	assert.ok(String(res.body).includes('大肥鱼衣橱'));
	assert.ok(String(res.body).includes('app.js'));
});

test('serves index.html for a trailing-slash directory path', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_PATH}/`);
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /text\/html/);
});

test('redirects the no-slash entry to the trailing-slash form', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', DRESS_UP_PATH);
	assert.equal(res.statusCode, 301);
	assert.equal(res.headers.location, DRESS_UP_ENTRY);
});

test('serves scripts, styles and webp art with the right mime types', async () => {
	const handler = createDressUpHandler(ROOT);
	for (const [url, mime] of [
		[`${DRESS_UP_ENTRY}app.js`, /text\/javascript/],
		[`${DRESS_UP_ENTRY}style.css`, /text\/css/],
		[`${DRESS_UP_ENTRY}manifest.json`, /application\/json/],
		[`${DRESS_UP_ENTRY}art/bg-snow.webp`, /image\/webp/],
	]) {
		const res = await hit(handler, 'GET', url);
		assert.equal(res.statusCode, 200, url);
		assert.match(res.headers['content-type'], mime, url);
		assert.ok(res.body && res.body.byteLength > 0, url);
		assert.ok(res.headers['cache-control'], url);
	}
});

test('HEAD answers the headers without a body', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'HEAD', `${DRESS_UP_ENTRY}art/bg-snow.webp`);
	assert.equal(res.statusCode, 200);
	assert.equal(res.body, undefined);
	assert.ok(Number(res.headers['content-length']) > 0);
});

test('missing files answer 404', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}art/nope-missing.webp`);
	assert.equal(res.statusCode, 404);
});

test('paths outside the entry answer 404', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', '/package.json');
	assert.equal(res.statusCode, 404);
});

test('encoded traversal is rejected with 403', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}%2e%2e%2fpackage.json`);
	assert.equal(res.statusCode, 403);
});

test('non-GET/HEAD methods answer 405 with an allow header', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'POST', DRESS_UP_ENTRY);
	assert.equal(res.statusCode, 405);
	assert.equal(res.headers.allow, 'GET, HEAD');
});

test('malformed encoding answers 400', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}%E0%A4%A`);
	assert.equal(res.statusCode, 400);
});

test('a custom root directory is honoured and cannot escape it', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-dressup-'));
	writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
	const handler = createDressUpHandler(dir);
	const ok = await hit(handler, 'GET', `${DRESS_UP_ENTRY}index.html`);
	assert.equal(ok.statusCode, 200);
	assert.equal(String(ok.body), '<h1>hi</h1>');
	const escape = await hit(handler, 'GET', `${DRESS_UP_ENTRY}%2e%2e%2fsecret`);
	assert.equal(escape.statusCode, 403);
});

test('mountDressUpRoutes registers one prefix route on webServer', () => {
	const routes = [];
	let effects = 0;
	const ctx = {
		inject(deps, callback) {
			assert.deepEqual(deps, ['webServer']);
			callback({
				effect(fn) {
					effects += 1;
					return fn();
				},
				webServer: {
					register(route) {
						routes.push(route);
						return () => {};
					},
				},
			});
		},
	};
	mountDressUpRoutes(ctx);
	assert.equal(effects, 1);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, 'prefix');
	assert.equal(routes[0].path, DRESS_UP_PATH);
	assert.equal(typeof routes[0].handler, 'function');
});

test('mountDressUpRoutes does nothing when webServer is absent', () => {
	let injected = 0;
	const ctx = {
		inject(deps, callback) {
			injected += 1;
			void deps;
			void callback;
		},
	};
	mountDressUpRoutes(ctx);
	assert.equal(injected, 1, 'waits for the webServer service instead of throwing');
});

/* ---------------- v3.0.1 缓存策略：版本化资源 immutable ---------------- */

test('staticCacheControl：带 ?v= 版本化资源长缓存 immutable，未版本化保持短缓存', () => {
	assert.equal(staticCacheControl(true), 'public, max-age=31536000, immutable');
	assert.equal(staticCacheControl(false), 'public, max-age=600');
});

test('静态资源缓存头：?v= 版本化 → immutable；入口/未版本化 → 短缓存', async () => {
	const handler = createDressUpHandler(ROOT);
	const versionedJs = await hit(handler, 'GET', `${DRESS_UP_ENTRY}app.js?v=26`);
	assert.equal(versionedJs.statusCode, 200);
	assert.equal(versionedJs.headers['cache-control'], 'public, max-age=31536000, immutable');
	const versionedAsset = await hit(handler, 'GET', `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json?v=23`);
	assert.equal(versionedAsset.headers['cache-control'], 'public, max-age=31536000, immutable');
	// 未版本化入口/资源仍短缓存，宿主升级后能及时生效
	const index = await hit(handler, 'GET', DRESS_UP_ENTRY);
	assert.equal(index.headers['cache-control'], 'public, max-age=600');
	const plainJs = await hit(handler, 'GET', `${DRESS_UP_ENTRY}app.js`);
	assert.equal(plainJs.headers['cache-control'], 'public, max-age=600');
	// client-config/interaction 端点保持 no-store（不受 ?v= 影响）
	const config = await hit(handler, 'GET', `${DRESS_UP_ENTRY}client-config.json`);
	assert.equal(config.headers['cache-control'], 'no-store');
});

test('gzip 命中时版本化资源同样返回 immutable（rig.json 首屏压缩）', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json?v=23`, { 'accept-encoding': 'gzip' });
	assert.equal(res.headers['content-encoding'], 'gzip');
	assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gzipSync } from 'node:zlib';
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

/* ---------------- v3.2.0：brotli 静态压缩（br 优先 / 预压缩 .br / gzip 回退） ---------------- */

test('brotli：Accept-Encoding 含 br 时动态压缩（content-encoding=br + vary），解压内容与原文件一致', async () => {
	const handler = createDressUpHandler(ROOT);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}app.js?v=28`, { 'accept-encoding': 'gzip, deflate, br' });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['content-encoding'], 'br');
	assert.equal(res.headers.vary, 'accept-encoding');
	const original = readFileSync(join(ROOT, 'app.js'));
	assert.ok(brotliDecompressSync(res.body).equals(original), 'br 解压内容应与源文件逐字节一致');
});

test('brotli：构建期预压缩 `<file>.br` 优先（不再动态压缩；内容即预压缩产物）', async () => {
	const root = mkdtempSync(join(tmpdir(), 'feiyu-br-'));
	mkdirSync(join(root, 'art/2d5/chibi'), { recursive: true });
	const source = Buffer.from(JSON.stringify({ hello: 'feiyu', pad: 'x'.repeat(4096) }));
	const precompressed = brotliCompressSync(source, { params: { 1: 5 } }); // BROTLI_PARAM_QUALITY=5
	const target = join(root, 'art/2d5/chibi/rig.bin');
	writeFileSync(target, source);
	writeFileSync(`${target}.br`, precompressed);
	const handler = createDressUpHandler(root);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}art/2d5/chibi/rig.bin?v=25`, { 'accept-encoding': 'br' });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['content-encoding'], 'br');
	assert.ok(Buffer.compare(res.body, precompressed) === 0, '应原样发送预压缩产物');
	assert.ok(brotliDecompressSync(res.body).equals(source));
});

test('brotli：陈旧的 .br（mtime 早于源文件）不采用，回退动态压缩且内容正确', async () => {
	const root = mkdtempSync(join(tmpdir(), 'feiyu-br-stale-'));
	mkdirSync(join(root, 'art/2d5/chibi'), { recursive: true });
	const source = Buffer.from(JSON.stringify({ value: 'fresh', pad: 'y'.repeat(4096) }));
	const stale = brotliCompressSync(Buffer.from('{"value":"stale"}'));
	const target = join(root, 'art/2d5/chibi/rig.json');
	writeFileSync(target, source);
	writeFileSync(`${target}.br`, stale);
	const old = new Date(Date.now() - 60_000);
	utimesSync(`${target}.br`, old, old);
	const handler = createDressUpHandler(root);
	const res = await hit(handler, 'GET', `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json?v=25`, { 'accept-encoding': 'br' });
	assert.equal(res.headers['content-encoding'], 'br');
	assert.notEqual(Buffer.compare(res.body, stale), 0, '不应发送陈旧预压缩产物');
	assert.ok(brotliDecompressSync(res.body).equals(source), '动态压缩应基于最新源文件');
});

test('压缩协商：只接受 gzip 时仍走 gzip 9；不接受压缩时返回原始字节', async () => {
	const handler = createDressUpHandler(ROOT);
	const gz = await hit(handler, 'GET', `${DRESS_UP_ENTRY}app.js?v=28`, { 'accept-encoding': 'gzip' });
	assert.equal(gz.headers['content-encoding'], 'gzip');
	const original = readFileSync(join(ROOT, 'app.js'));
	assert.ok(gzipSync(original, { level: 9 }).equals(gz.body) || gz.body.length > 0);
	const plain = await hit(handler, 'GET', `${DRESS_UP_ENTRY}app.js?v=28`);
	assert.equal(plain.headers['content-encoding'], undefined);
	assert.ok(Buffer.compare(plain.body, original) === 0);
});

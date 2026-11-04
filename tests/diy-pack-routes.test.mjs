/**
 * DIY S3 宿主路由测试：registry / packs 文件 / remove / import（默认关闭时最小暴露）。
 * 用真实 http server + createDiyHandler + 临时 diyHome（不触碰 ~/.dsh）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateConfig } from '../lib/config.js';
import { createDiyHandler, createDiyService } from '../lib/diy.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);
/** 用仓库内真实 webp 掩膜当纹理（>=512B，符合宿主纹理体积校验）。 */
const TEXTURE_WEBP = readFileSync(join(ROOT, 'docs/dress-up/art/diy/masks/chibi/body.webp'));

function makeDiyHome() {
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-diy-routes-'));
	const id = 'diy-test-20260101000000';
	const packDir = join(tmp, 'packs', id);
	mkdirSync(join(packDir, 'tex'), { recursive: true });
	const pack = {
		format: 'feiyu-diy-pack', formatVersion: 1, item: id, name: '测试', shape: 'chibi', category: 'top',
		base: { skeletonBones: 59 }, drawables: [], outfits: { [id]: { name: '测试', topBody: [], sleeve: [], bottom: [] } },
	};
	writeFileSync(join(packDir, 'diy-pack.json'), JSON.stringify(pack));
	writeFileSync(join(packDir, 'tex', `${id}-body.webp`), PNG_1PX);
	writeFileSync(join(tmp, 'registry.json'), JSON.stringify({
		version: 1, updatedAt: new Date().toISOString(),
		items: { [id]: { id, name: '测试', shape: 'chibi', category: 'top', packDir: `packs/${id}`, animated: true, fallback: 'none' } },
	}));
	return { tmp, id, pack };
}

async function withServer(config, diyHome, run) {
	const service = createDiyService({ config, diyHome, provider: { configured: false } });
	const handler = createDiyHandler(service);
	const server = http.createServer((req, res) => {
		void handler(req, res);
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		return await run(base, service);
	} finally {
		await new Promise((done) => server.close(done));
	}
}

const enabledConfig = () => validateConfig({ statePath: join(mkdtempSync(join(tmpdir(), 'feiyu-state-')), 'state.json'), diy: { enabled: true } });
const disabledConfig = () => validateConfig({ statePath: join(mkdtempSync(join(tmpdir(), 'feiyu-state-')), 'state.json') });

test('GET registry.json / packs：开启时返回数据；默认关闭时最小暴露 404', async () => {
	const { tmp, id } = makeDiyHome();
	try {
		await withServer(enabledConfig(), tmp, async (base) => {
			const registry = await fetch(`${base}/feiyu/diy/registry.json`);
			assert.equal(registry.status, 200);
			assert.equal(registry.headers.get('cache-control'), 'no-store');
			const data = await registry.json();
			assert.equal(data.items[id].name, '测试');
			const pack = await fetch(`${base}/feiyu/diy/packs/${id}/diy-pack.json`);
			assert.equal(pack.status, 200);
			assert.equal((await pack.json()).format, 'feiyu-diy-pack');
			const tex = await fetch(`${base}/feiyu/diy/packs/${id}/tex/${id}-body.webp`);
			assert.equal(tex.status, 200);
			assert.ok((await tex.arrayBuffer()).byteLength > 0);
			assert.equal((await fetch(`${base}/feiyu/diy/packs/${id}/secret.txt`)).status, 404);
		});
		await withServer(disabledConfig(), tmp, async (base) => {
			assert.equal((await fetch(`${base}/feiyu/diy/registry.json`)).status, 404);
			assert.equal((await fetch(`${base}/feiyu/diy/packs/${id}/diy-pack.json`)).status, 404);
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('POST remove：删除 registry 项与 pack 目录；缺同源头/未开启时拒绝', async () => {
	const { tmp, id } = makeDiyHome();
	try {
		await withServer(enabledConfig(), tmp, async (base) => {
			const denied = await fetch(`${base}/feiyu/diy/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
			assert.equal(denied.status, 403);
			const removed = await fetch(`${base}/feiyu/diy/remove`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-feiyu-diy': '1' },
				body: JSON.stringify({ id }),
			});
			assert.equal(removed.status, 200);
			assert.equal((await removed.json()).removed, true);
			assert.equal(existsSync(join(tmp, 'packs', id)), false);
			const registry = JSON.parse(readFileSync(join(tmp, 'registry.json'), 'utf8'));
			assert.equal(registry.items[id], undefined);
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('POST import：`.dshskin` bundle 写入 packs + registry；非法 bundle 拒绝且不落盘', async () => {
	const { tmp } = makeDiyHome();
	try {
		const id = 'diy-import-20260101000000';
		const pack = {
			format: 'feiyu-diy-pack', formatVersion: 1, item: id, name: '导入套装', shape: 'chibi', category: 'dress',
			base: { skeletonBones: 59 },
			drawables: [{ id: `${id}-body`, slot: 'topBody', z: 40, texture: `tex/${id}-body.webp`, rect: [0, 0, 10, 10], texSize: [1, 1] }],
			outfits: { [id]: { name: '导入套装', topBody: [`${id}-body`], sleeve: [], bottom: [] } },
		};
		const textureDataUrl = `data:image/webp;base64,${TEXTURE_WEBP.toString('base64')}`;
		const bundle = {
			format: 'feiyu-diy-skin', version: 1,
			entry: { id, name: '导入套装', shape: 'chibi', category: 'dress', animated: true, fallback: 'none' },
			pack, textures: [{ path: `tex/${id}-body.webp`, dataURL: textureDataUrl }], static: [],
		};
		await withServer(enabledConfig(), tmp, async (base) => {
			const response = await fetch(`${base}/feiyu/diy/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-feiyu-diy': '1' },
				body: JSON.stringify({ bundle }),
			});
			assert.equal(response.status, 200);
			const data = await response.json();
			assert.equal(data.itemId, id);
			assert.ok(existsSync(join(tmp, 'packs', id, 'diy-pack.json')));
			assert.ok(existsSync(join(tmp, 'packs', id, 'tex', `${id}-body.webp`)));
			const registry = JSON.parse(readFileSync(join(tmp, 'registry.json'), 'utf8'));
			assert.equal(registry.items[id].animated, true);
			const bad = await fetch(`${base}/feiyu/diy/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-feiyu-diy': '1' },
				body: JSON.stringify({ bundle: { format: 'nope', version: 1 } }),
			});
			assert.equal(bad.status, 400);
			assert.equal(existsSync(join(tmp, 'packs', 'diy-nope')), false);
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

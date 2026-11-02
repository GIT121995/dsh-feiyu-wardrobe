import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

/** 断言相对路径存在、是 WebP 且体积像真图。 */
function assertWebp(rel, label) {
	const file = join(ROOT, rel);
	assert.ok(existsSync(file), `${label}: missing ${rel}`);
	const bytes = readFileSync(file);
	assert.ok(bytes.byteLength > 1024, `${label}: too small ${rel}`);
	assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${label}: not RIFF ${rel}`);
	assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${label}: not WEBP ${rel}`);
}

/** 递归列出目录下所有文件（相对 ROOT 的 posix 路径）。 */
function walk(relDir) {
	/** @type {string[]} */
	const out = [];
	const dir = join(ROOT, relDir);
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) {
			const full = join(entry.parentPath || entry.path, entry.name);
			out.push(full.slice(ROOT.length + 1).split('\\').join('/'));
		}
	}
	return out;
}

test('manifest v5：两种身形（base/overlay/bounds）+ 5 个分类', () => {
	assert.equal(MANIFEST.version, 5);
	assert.deepEqual(MANIFEST.shapes.map((shape) => shape.id), ['chibi', 'girl']);
	assert.deepEqual(
		MANIFEST.categories.map((category) => category.id),
		['outfits', 'tops', 'bottoms', 'backgrounds', 'effects'],
	);
	assert.ok(typeof MANIFEST.credits === 'string' && MANIFEST.credits.length > 10);
	for (const shape of MANIFEST.shapes) {
		assert.equal(shape.base, `art/${shape.id}/base.webp`, `${shape.id} 需要 base 素体`);
		assert.equal(shape.overlay, `art/${shape.id}/overlay.webp`, `${shape.id} 需要 overlay 叠层`);
		assert.ok(shape.bounds && typeof shape.bounds === 'object', `${shape.id} 需要 bounds`);
	}
});

test('每个身形的素体与头发叠层齐全（透明 WebP）', () => {
	for (const shape of MANIFEST.shapes) {
		assertWebp(shape.base, `${shape.id}/base`);
		assertWebp(shape.overlay, `${shape.id}/overlay`);
	}
});

test('v0.8 保守范围：套装只保留「经典女仆装」，其余 5 套已移除', () => {
	const outfits = MANIFEST.items.outfits;
	assert.deepEqual(
		outfits.map((item) => item.id),
		['none', 'maid'],
		'套装应只剩 none + maid',
	);
	const removed = ['starry', 'strawberry', 'gothic', 'forest', 'sakura'];
	for (const shape of MANIFEST.shapes) {
		for (const id of removed) {
			const rel = `art/${shape.id}/layers/dress-${id}.webp`;
			assert.ok(!existsSync(join(ROOT, rel)), `已移除的套装图层不应再存在：${rel}`);
		}
	}
});

test('每个身形 × 每件衣服单品的图层齐全且是 WebP（保守范围共 6 件/身形）', () => {
	const clothing = ['outfits', 'tops', 'bottoms'];
	let count = 0;
	for (const categoryId of clothing) {
		const items = MANIFEST.items[categoryId] || [];
		assert.ok(items.length >= 2, `${categoryId} 至少要有占位 + 1 件单品`);
		for (const item of items) {
			if (item.id === 'none') continue;
			assert.ok(item.layer && typeof item.layer === 'object', `${categoryId}/${item.id} 需要 layer 映射`);
			assert.ok(typeof item.z === 'number', `${categoryId}/${item.id} 需要 z`);
			for (const shape of MANIFEST.shapes) {
				const layer = item.layer[shape.id];
				assert.ok(layer, `${categoryId}/${item.id} 缺少 ${shape.id} 图层`);
				assertWebp(layer, `${categoryId}/${item.id}/${shape.id}`);
				count += 1;
			}
		}
	}
	const perShape = 6; // 1 连衣裙 + 3 上衣 + 2 下装
	assert.equal(count, MANIFEST.shapes.length * perShape, `衣服图层总数应为 ${MANIFEST.shapes.length * perShape}（每身形 ${perShape} 件）`);
});

test('每个身形的 bounds 合理（同一身形固定，不随穿搭变化）', () => {
	for (const shape of MANIFEST.shapes) {
		const { top, bottom } = shape.bounds;
		assert.ok(typeof top === 'number' && top >= 0 && top < 0.5, `${shape.id} bounds.top 不合理：${top}`);
		assert.ok(typeof bottom === 'number' && bottom > 0.6 && bottom <= 1, `${shape.id} bounds.bottom 不合理：${bottom}`);
		assert.ok(bottom > top, `${shape.id} bounds.bottom 应大于 top`);
	}
	assert.equal(MANIFEST.bounds, undefined, 'v5 已删除顶层 bounds（改到 shapes[].bounds）');
});

test('旧整套立绘（dress-*/combo-* 裸路径）不再被引用，也不再存在', () => {
	const filenames = [];
	const collect = (value, key) => {
		if (typeof value === 'string') filenames.push([key, value]);
		else if (value && typeof value === 'object') {
			for (const [childKey, child] of Object.entries(value)) collect(child, `${key}.${childKey}`);
		}
	};
	collect(MANIFEST, 'manifest');
	for (const [key, value] of filenames) {
		if (!/^art\//.test(value)) continue;
		assert.ok(
			!/^art\/(chibi|girl)\/(dress|combo)-[^/]+\.webp$/.test(value),
			`${key} 仍引用旧整套立绘：${value}`,
		);
	}
	const oldFiles = walk('art').filter((rel) => /^art\/(chibi|girl)\/(dress|combo)-[^/]+\.webp$/.test(rel));
	assert.deepEqual(oldFiles, [], `旧整套立绘文件应删除：${oldFiles.join(', ')}`);
});

test('悬浮小鲸鱼默认穿搭小图存在（readOutfit 的 fallback）', () => {
	assertWebp('art/pet-default.webp', 'pet-default');
});

test('右侧衣柜只放「衣服本身」的图标，背景带地面线', () => {
	for (const item of MANIFEST.items.backgrounds) {
		assertWebp(item.file, `background ${item.id}`);
		assertWebp(item.thumb, `background thumb ${item.id}`);
		assert.ok(
			typeof item.floor === 'number' && item.floor > 0.5 && item.floor < 1,
			`background ${item.id} floor 应为 0.5–1 之间`,
		);
	}
	assert.ok(MANIFEST.items.effects.length >= 3);
	for (const categoryId of ['outfits', 'tops', 'bottoms']) {
		for (const item of MANIFEST.items[categoryId]) {
			if (item.id === 'none') continue;
			assert.ok(item.icon, `${categoryId}/${item.id} 需要只有衣服的 icon`);
			assertWebp(item.icon, `${categoryId}/${item.id} icon`);
			assert.ok(!item.thumb, `${categoryId}/${item.id} 不应再用「穿好衣服的人」缩略图`);
		}
	}
});

test('宿主半区 readOutfit 接受 data URL / art 路径，并 fallback 到 pet-default', () => {
	const client = readFileSync(join(ROOT, '..', '..', 'lib', 'client.js'), 'utf8');
	assert.ok(client.includes("startsWith('data:image/')"), 'readOutfit 应接受合成小图 data URL');
	assert.ok(client.includes("startsWith('art/')"), 'readOutfit 应兼容 art/ 相对路径');
	assert.ok(client.includes("'art/pet-default.webp'"), 'readOutfit 的 fallback 应为 art/pet-default.webp');
	assert.ok(
		!client.includes("'art/chibi/dress-maid.webp'"),
		'fallback 不应再指向 v0.7 已删除的整套立绘',
	);
	assert.ok(
		client.includes("outfit.image.startsWith('data:')"),
		'悬浮小鲸鱼渲染时 data URL 不能拼 GAME_BASE 前缀',
	);
});

test('游戏页改为图层栈、通过 ESM 共享核心逻辑并 cache-bust 到 v9', () => {
	const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
	assert.match(html, /app\.js\?v=\d+/);
	assert.match(html, /style\.css\?v=\d+/);
	assert.ok(html.includes('type="module"'));
	assert.ok(!html.includes('github.io'), 'game page should not hardcode GitHub Pages');
	for (const slot of ['base', 'bottom', 'top', 'outfit', 'overlay']) {
		assert.ok(html.includes(`data-layer="${slot}"`), `index.html 应有 ${slot} 图层槽位`);
	}
	assert.ok(!html.includes('id="figureImg"'), 'v5 不再用单张立绘 <img>');

	const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
	assert.ok(/from '\.\/wardrobe-core\.js(\?v=\d+)?'/.test(app), 'app.js 应复用 wardrobe-core');
	assert.ok(app.includes('resolveLayers'), 'app.js 应按 resolveLayers 叠图层');
	assert.ok(!app.includes('resolveImage'), 'app.js 不应再用 v4 的 resolveImage');
	assert.ok(app.includes('feiyu:outfit'), 'app.js 必须把当前穿搭写进 localStorage 给悬浮鲸鱼用');
	// v0.8 性能：小图合成移出点击路径（debounce + 空闲回调 + 异步 toBlob）
	assert.ok(app.includes('toBlob'), '小图合成应走异步 canvas.toBlob');
	assert.ok(app.includes('requestIdleCallback'), '小图合成应放到浏览器空闲时执行');
	assert.ok(!app.includes('composePetImageNow'), '不应再在点击路径里同步合成小图');
	assert.ok(app.includes('persistTimer'), 'persist 应有 debounce 定时器');

	// v0.8 保守文案：去掉性感/身体评价/撒娇过头的台词
	const banned = ['转一圈', '裙底', '性感', '身材', '偷看', '亲亲', '抱抱'];
	for (const word of banned) assert.ok(!app.includes(word), `app.js 不应包含不保守文案「${word}」`);
	assert.ok(!html.includes('裙底'), 'index.html 不应包含不保守文案');

	assert.ok(!app.includes('github.io'), 'app.js should not hardcode GitHub Pages');
});

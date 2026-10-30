import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function assertWebp(rel, label) {
	const file = join(ROOT, rel);
	assert.ok(existsSync(file), `${label}: missing ${rel}`);
	const bytes = readFileSync(file);
	assert.ok(bytes.byteLength > 1024, `${label}: too small ${rel}`);
	assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${label}: not RIFF ${rel}`);
	assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${label}: not WEBP ${rel}`);
}

test('换装间 manifest 是 v2 分层结构', () => {
	assert.equal(MANIFEST.version, 2);
	assert.equal(typeof MANIFEST.base, 'string');
	assert.ok(Array.isArray(MANIFEST.gowns) && MANIFEST.gowns.length >= 6);
	assert.ok(Array.isArray(MANIFEST.coats) && MANIFEST.coats.length >= 2);
	assert.ok(Array.isArray(MANIFEST.hats) && MANIFEST.hats.length >= 4);
	assert.ok(Array.isArray(MANIFEST.backgrounds) && MANIFEST.backgrounds.length >= 4);
	assert.ok(Array.isArray(MANIFEST.effects) && MANIFEST.effects.length >= 3);
	assert.ok(Array.isArray(MANIFEST.bubbles) && MANIFEST.bubbles.length > 0);
	assert.ok(typeof MANIFEST.credits === 'string' && MANIFEST.credits.includes('YunYueSama'));
});

test('底座与全部图层文件存在且是有效 WebP', () => {
	assertWebp(MANIFEST.base, 'base');
	const groups = ['gowns', 'coats', 'hats', 'backgrounds'];
	for (const group of groups) {
		for (const item of MANIFEST[group]) {
			if (!item.file) continue;
			assert.ok(item.file.startsWith('art/'), `${item.id}: file should live under art/`);
			assertWebp(item.file, `${group}/${item.id}`);
			assert.ok(item.thumb, `${item.id}: thumb required`);
			assertWebp(item.thumb, `${group}/${item.id} thumb`);
			assert.equal(typeof item.name, 'string');
			assert.equal(typeof item.desc, 'string');
		}
	}
});

test('每个分类都有“不穿/不戴”的空选项', () => {
	for (const group of ['coats', 'hats', 'effects']) {
		const none = MANIFEST[group][0];
		assert.equal(none.id, 'none', group);
	}
});

test('布局锚点齐全（底座上下边界 + 裙子底边 + 头饰顶边）', () => {
	assert.ok(MANIFEST.layout);
	assert.ok(MANIFEST.layout.baseTop > 0 && MANIFEST.layout.baseTop < MANIFEST.layout.baseBottom);
	assert.ok(MANIFEST.layout.baseBottom < 1);
	for (const gown of MANIFEST.gowns) {
		if (gown.file) assert.ok(gown.bottom > MANIFEST.layout.baseTop && gown.bottom <= 1, `${gown.id} bottom`);
	}
	for (const hat of MANIFEST.hats) {
		if (hat.file) assert.ok(hat.top >= 0 && hat.top < MANIFEST.layout.baseBottom, `${hat.id} top`);
	}
});

test('游戏页 HTML 引用本地脚本与样式，不再依赖 GitHub Pages', () => {
	const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
	assert.ok(html.includes('app.js'));
	assert.ok(html.includes('style.css'));
	assert.ok(html.includes('manifest.json') || html.includes('app.js'));
	assert.ok(!html.includes('github.io'), 'game page should not hardcode GitHub Pages');
	const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
	assert.ok(!app.includes('github.io'), 'app.js should not hardcode GitHub Pages');
	assert.ok(app.includes('feiyu:outfit'), 'app.js must publish the outfit for the floating pet');
});

test('缩略图目录不为空且尺寸合理', () => {
	const dir = join(ROOT, 'art', 'thumbs');
	assert.ok(existsSync(dir));
	const thumbs = readFileSync(join(ROOT, 'manifest.json'));
	assert.ok(thumbs.byteLength > 0);
	const sample = join(dir, 'gown-starry.webp');
	assert.ok(existsSync(sample));
	assert.ok(statSync(sample).size > 512);
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('manifest v4：两种身形 + 5 个分类', () => {
	assert.equal(MANIFEST.version, 4);
	assert.deepEqual(MANIFEST.shapes.map((shape) => shape.id), ['chibi', 'girl']);
	assert.deepEqual(
		MANIFEST.categories.map((category) => category.id),
		['outfits', 'tops', 'bottoms', 'backgrounds', 'effects'],
	);
	assert.ok(typeof MANIFEST.credits === 'string' && MANIFEST.credits.length > 10);
});

test('每个身形的整套立绘齐全（连衣裙 + 上衣×下装组合）', () => {
	const dresses = MANIFEST.items.outfits.filter((item) => item.id !== 'none').map((item) => item.id);
	const tops = MANIFEST.items.tops.map((item) => item.id);
	const bottoms = MANIFEST.items.bottoms.map((item) => item.id);
	assert.ok(dresses.length >= 4, '至少 4 套连衣裙');
	assert.ok(tops.length >= 2 && bottoms.length >= 2, '至少 2x2 上衣/下装组合');
	for (const shape of MANIFEST.shapes) {
		for (const id of dresses) assertWebp(`art/${shape.id}/dress-${id}.webp`, `${shape.id}/dress-${id}`);
		for (const top of tops) {
			for (const bottom of bottoms) {
				assertWebp(`art/${shape.id}/combo-${top}-${bottom}.webp`, `${shape.id}/combo-${top}-${bottom}`);
			}
		}
	}
});

test('bounds 覆盖所有套装立绘，且上下边界合理', () => {
	for (const shape of MANIFEST.shapes) {
		for (const item of MANIFEST.items.outfits) {
			if (item.id === 'none') continue;
			const file = `art/${shape.id}/dress-${item.id}.webp`;
			const bounds = MANIFEST.bounds[file];
			assert.ok(bounds, `missing bounds: ${file}`);
			assert.ok(bounds.top >= 0 && bounds.top < 0.5, `${file} top`);
			assert.ok(bounds.bottom > 0.6 && bounds.bottom <= 1, `${file} bottom`);
		}
	}
});

test('背景 / 特效 / 缩略图引用都存在', () => {
	for (const item of MANIFEST.items.backgrounds) {
		assertWebp(item.file, `background ${item.id}`);
		assertWebp(item.thumb, `background thumb ${item.id}`);
	}
	assert.ok(MANIFEST.items.effects.length >= 3);
	for (const categoryId of ['outfits', 'tops', 'bottoms']) {
		for (const item of MANIFEST.items[categoryId]) {
			if (item.id === 'none') continue;
			assert.ok(item.thumb, `${categoryId}/${item.id} thumb`);
			assertWebp(item.thumb, `${categoryId}/${item.id} thumb`);
		}
	}
});

test('游戏页不再依赖 GitHub Pages，且通过 ESM 模块共享核心逻辑', () => {
	const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
	assert.ok(html.includes('app.js?v=6'));
	assert.ok(html.includes('type="module"'));
	assert.ok(!html.includes('github.io'), 'game page should not hardcode GitHub Pages');
	const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
	assert.ok(app.includes("from './wardrobe-core.js'"), 'app.js 应复用 wardrobe-core');
	assert.ok(app.includes('feiyu:outfit'), 'app.js 必须把当前立绘写进 localStorage 给悬浮鲸鱼用');
	assert.ok(!app.includes('github.io'), 'app.js should not hardcode GitHub Pages');
});

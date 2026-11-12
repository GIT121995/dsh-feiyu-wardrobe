/**
 * B-M3b / v3.2.0：tools/art/build_2d5.py 多页图集构建测试。
 * - 两页（base/cutout）输入 → 两张 atlas + rig.atlases/drawables[].atlas + 每页 pixelEqual；
 * - 五页懒加载套装页（base + 4 outfit）输入 → 页序/文件名/每页归属严格按 PLAN §1.1；
 * - 页数上限 MAX_PAGES=6：7 页输入必须失败（防止懒加载页数悄悄膨胀）；
 * - 旧单图集输入 → 输出形状不变（无 atlases / 无 drawable.atlas）；
 * - 产物可被 M3 runtime core 的 normalizeAtlases/resolveDrawableAtlas 消费（2 页契约）。
 * 依赖：python3 + Pillow/numpy（缺失时 skip 并注明）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { normalizeAtlases, resolveDrawableAtlas } from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';

/** v3.2.0 lazy outfit page 契约（PLAN §1.1）：固定页序 + 文件名。 */
const LAZY_PAGE_IDS = ['base', 'maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid'];
const LAZY_PAGE_FILES = ['atlas.webp', 'atlas-2.webp', 'atlas-3.webp', 'atlas-4.webp', 'atlas-5.webp'];

function pythonAvailable() {
	const result = spawnSync(PYTHON, ['-c', 'import PIL, numpy; print("ok")'], { encoding: 'utf8' });
	return result.status === 0 && String(result.stdout).trim() === 'ok';
}

function makeTextures(texdir) {
	mkdirSync(texdir, { recursive: true });
	const script = [
		'from PIL import Image, ImageDraw',
		'import sys, pathlib',
		'tex = pathlib.Path(sys.argv[1])',
		'def make(name, color):',
		'    im = Image.new("RGBA", (8, 10), (0, 0, 0, 0))',
		'    d = ImageDraw.Draw(im)',
		'    d.rectangle((1, 1, 6, 8), fill=color)',
		'    im.save(tex / name)',
		'make("a.webp", (200, 40, 40, 255))',
		'make("b.webp", (40, 80, 220, 255))',
	].join('\n');
	const result = spawnSync(PYTHON, ['-c', script, texdir], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
}

function makeDrawable(id, slot, texture, atlas) {
	return {
		id, slot, z: slot === 'body' ? 10 : 40, role: slot,
		texture: `tex/${texture}`, texSize: [8, 10], atlas,
		mesh: {
			positions: [[20, 20], [30, 20], [30, 40], [20, 40]],
			uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
			bones: [[0, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			deform: [[0, 0], [0, 0], [0, 0], [0, 0]],
			indices: [0, 1, 2, 0, 2, 3],
		},
	};
}

function makeRig(multi) {
	const d1 = makeDrawable('body-torso', 'body', 'a.webp', multi ? 'base' : undefined);
	const d2 = makeDrawable('hoodie-body', 'topBody', 'b.webp', multi ? 'cutout' : undefined);
	const rig = {
		format: 'feiyu-test-rig', shape: 'chibi',
		skeleton: { bones: [
			{ id: 'root', parent: null, base: [10, 10], angle: 0, length: 1 },
			{ id: 'hips', parent: 'root', base: [20, 30], angle: 90, length: 10 },
		] },
		deformers: [{ id: 'headYawWarp', type: 'warp', mode: 'headYawSquash', pivot: [20, 20], bind: { param: 'HeadAngleY' } }],
		physics: [{ id: 'skirtP0', chain: ['skirtP00'], nodes: [[20, 30], [20, 40]], parent: 'hips' }],
		slots: { body: ['body-torso'] },
		drawables: [d1, d2],
		outfits: { 'test-outfit': { name: '测试', topBody: ['hoodie-body'] } },
	};
	if (multi) {
		rig.atlasPages = [{ id: 'base', file: 'atlas.webp' }, { id: 'cutout', file: 'atlas2.webp' }];
	}
	return rig;
}

/** v3.2.0 lazy outfit page 输入：1 个 base drawable + 4 套装 × top/skirt（显式 drawables 分组）。 */
function makeLazyRig() {
	const combos = ['maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid'];
	const base = makeDrawable('body-torso', 'body', 'a.webp');
	const drawables = [base];
	const outfits = { base: { name: '素体' } };
	const pages = [{ id: 'base', file: 'atlas.webp', drawables: ['body-torso'] }];
	for (const combo of combos) {
		const ids = [`${combo}-top`, `${combo}-skirt`];
		drawables.push(makeDrawable(ids[0], 'topBody', 'b.webp'));
		drawables.push(makeDrawable(ids[1], 'bottom', 'a.webp'));
		outfits[combo] = { name: combo, topBody: [ids[0]], bottom: [ids[1]] };
		pages.push({ id: combo, file: LAZY_PAGE_FILES[pages.length], drawables: ids });
	}
	return {
		format: 'feiyu-test-rig', shape: 'chibi',
		skeleton: { bones: [
			{ id: 'root', parent: null, base: [10, 10], angle: 0, length: 1 },
			{ id: 'hips', parent: 'root', base: [20, 30], angle: 90, length: 10 },
		] },
		deformers: [{ id: 'headYawWarp', type: 'warp', mode: 'headYawSquash', pivot: [20, 20], bind: { param: 'HeadAngleY' } }],
		physics: [{ id: 'skirtP0', chain: ['skirtP00'], nodes: [[20, 30], [20, 40]], parent: 'hips' }],
		slots: { body: ['body-torso'] },
		drawables, outfits,
		atlasPages: pages,
	};
}

function makeOverflowRig(pageCount) {
	const ids = [];
	const drawables = [];
	const atlasPages = [];
	for (let i = 0; i < pageCount; i += 1) {
		const id = `part-${i}`;
		ids.push(id);
		drawables.push(makeDrawable(id, 'body', 'a.webp'));
		atlasPages.push({ id: `page-${i}`, drawables: [id] });
	}
	return {
		format: 'feiyu-test-rig', shape: 'chibi',
		skeleton: { bones: [{ id: 'root', parent: null, base: [10, 10], angle: 0, length: 1 }] },
		deformers: [],
		physics: [],
		slots: { body: ids },
		drawables,
		outfits: {},
		atlasPages,
	};
}

function runBuilder(rigPath, texdir, outDir) {
	return spawnSync(PYTHON, [
		join(ROOT, 'tools', 'art', 'build_2d5.py'),
		'--rig', rigPath, '--texdir', texdir, '--out', outDir, '--shape', 'chibi',
	], { encoding: 'utf8' });
}

test('build_2d5.py：两页图集构建（atlasPages + drawables[].atlas）→ pixelEqual + M3 runtime 可消费', () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-b2d5-multi-'));
	try {
		const texdir = join(tmp, 'tex');
		makeTextures(texdir);
		const rigPath = join(tmp, 'rig-multi.json');
		writeFileSync(rigPath, JSON.stringify(makeRig(true)));
		const out = join(tmp, 'out');
		const result = runBuilder(rigPath, texdir, out);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /pages 2/);
		assert.match(result.stdout, /pixelEqual True/);

		const rig = JSON.parse(readFileSync(join(out, 'chibi', 'rig.json'), 'utf8'));
		assert.ok(Array.isArray(rig.atlases), '输出 rig 应含 atlases');
		assert.deepEqual(rig.atlases.map((atlas) => atlas.id), ['base', 'cutout']);
		assert.equal(rig.atlases.length, 2);
		for (const atlas of rig.atlases) {
			assert.ok(atlas.width <= 4096 && atlas.height <= 4096, `图集页超限：${atlas.width}x${atlas.height}`);
			assert.ok(existsSync(join(out, 'chibi', atlas.file)), `缺少图集文件 ${atlas.file}`);
		}
		assert.equal(rig.drawables.find((d) => d.id === 'body-torso').atlas, 'base');
		assert.equal(rig.drawables.find((d) => d.id === 'hoodie-body').atlas, 'cutout');
		assert.equal(rig.product.pages, 2);
		const report = JSON.parse(readFileSync(join(out, 'chibi', 'build-report.json'), 'utf8'));
		assert.equal(report.pages, 2);
		assert.ok(report.atlases.every((page) => page.pixelEqual === true));

		// 与 M3 runtime core 契约对齐
		const normalized = normalizeAtlases(rig);
		assert.equal(normalized.ok, true, normalized.errors.join(','));
		assert.equal(normalized.legacy, false);
		assert.deepEqual(normalized.atlases.map((atlas) => atlas.id), ['base', 'cutout']);
		assert.equal(resolveDrawableAtlas(rig.drawables.find((d) => d.id === 'hoodie-body'), normalized.atlases), 1);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('build_2d5.py：五页懒加载套装页（v3.2.0 契约：页序/文件名/归属/pixelEqual）', () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-b2d5-lazy-'));
	try {
		const texdir = join(tmp, 'tex');
		makeTextures(texdir);
		const rigPath = join(tmp, 'rig-lazy.json');
		const rigIn = makeLazyRig();
		writeFileSync(rigPath, JSON.stringify(rigIn));
		const out = join(tmp, 'out');
		const result = runBuilder(rigPath, texdir, out);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /pages 5/);
		assert.match(result.stdout, /pixelEqual True/);

		const rig = JSON.parse(readFileSync(join(out, 'chibi', 'rig.json'), 'utf8'));
		assert.equal(rig.atlases.length, 5);
		assert.deepEqual(rig.atlases.map((atlas) => atlas.id), LAZY_PAGE_IDS);
		assert.deepEqual(rig.atlases.map((atlas) => atlas.file), LAZY_PAGE_FILES);
		assert.deepEqual(rig.atlas, rig.atlases[0], 'rig.atlas 应为 atlases[0]（兼容旧消费者）');
		assert.equal(rig.m3.multiAtlas, true);
		assert.equal(rig.m3.atlasPages, 5);
		assert.equal(rig.product.pages, 5);
		for (const page of rig.atlases) {
			assert.ok(page.width <= 4096 && page.height <= 4096, `图集页超限：${page.width}x${page.height}`);
			assert.ok(existsSync(join(out, 'chibi', page.file)), `缺少图集文件 ${page.file}`);
		}
		// drawable → 页归属：每个 drawable 恰好一页，页 id/file 与 atlas 页表一致
		const pageById = new Map(rig.atlases.map((page) => [page.id, page]));
		const assigned = new Map();
		for (const d of rig.drawables) {
			assert.ok(pageById.has(d.atlas), `drawable ${d.id} 的 atlas=${d.atlas} 未声明`);
			assert.equal(d.texture, pageById.get(d.atlas).file, `drawable ${d.id} 的 texture 应为页文件`);
			assert.ok(!assigned.has(d.id), `drawable ${d.id} 被分到多页`);
			assigned.set(d.id, d.atlas);
		}
		assert.equal(assigned.size, rigIn.drawables.length, '所有 drawable 都必须归属某页');
		assert.equal(assigned.get('body-torso'), 'base');
		for (const combo of ['maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid']) {
			for (const id of [`${combo}-top`, `${combo}-skirt`]) {
				assert.equal(assigned.get(id), combo, `${id} 应归属套装页 ${combo}`);
				assert.ok(Array.isArray(rig.drawables.find((d) => d.id === id).atlasRect), `${id} 缺 atlasRect`);
			}
		}
		// 报告
		const report = JSON.parse(readFileSync(join(out, 'chibi', 'build-report.json'), 'utf8'));
		assert.equal(report.pages, 5);
		assert.deepEqual(report.atlases.map((page) => page.id), LAZY_PAGE_IDS);
		assert.deepEqual(report.atlases.map((page) => page.file), LAZY_PAGE_FILES);
		assert.ok(report.atlases.every((page) => page.pixelEqual === true), '每页必须 lossless 回读逐像素相等');
		assert.equal(report.atlases.reduce((n, page) => n + page.rects, 0), rig.drawables.length,
			'图集 rects 总数应等于 drawables 数');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('build_2d5.py：图集页数上限 MAX_PAGES=6（7 页输入必须失败）', () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-b2d5-cap-'));
	try {
		const texdir = join(tmp, 'tex');
		makeTextures(texdir);
		const rigPath = join(tmp, 'rig-overflow.json');
		writeFileSync(rigPath, JSON.stringify(makeOverflowRig(7)));
		const result = runBuilder(rigPath, texdir, join(tmp, 'out'));
		assert.notEqual(result.status, 0, '7 页图集应被 MAX_PAGES=6 拒绝');
		assert.match(`${result.stdout}\n${result.stderr}`, /上限 6/, '错误信息应说明页数上限 6');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('build_2d5.py：旧单图集路径输出形状不变（无 atlases / 无 drawable.atlas）+ pixelEqual', () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-b2d5-single-'));
	try {
		const texdir = join(tmp, 'tex');
		makeTextures(texdir);
		const rigPath = join(tmp, 'rig-single.json');
		writeFileSync(rigPath, JSON.stringify(makeRig(false)));
		const out = join(tmp, 'out');
		const result = runBuilder(rigPath, texdir, out);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /pages 1/);
		assert.match(result.stdout, /pixelEqual True/);
		const rig = JSON.parse(readFileSync(join(out, 'chibi', 'rig.json'), 'utf8'));
		assert.equal(rig.atlases, undefined, '旧路径不应输出 atlases');
		assert.equal(rig.drawables.some((d) => 'atlas' in d), false, '旧路径 drawable 不应带 atlas 字段');
		assert.equal(rig.atlas.file, 'atlas.webp');
		assert.ok(existsSync(join(out, 'chibi', 'atlas.webp')));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

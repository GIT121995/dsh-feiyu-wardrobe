/**
 * B-M3b：tools/art/build_2d5.py 多页图集构建测试。
 * - 两页（base/cutout）输入 → 两张 atlas + rig.atlases/drawables[].atlas + 每页 pixelEqual；
 * - 旧单图集输入 → 输出形状不变（无 atlases / 无 drawable.atlas）；
 * - 产物可被 M3 runtime core 的 normalizeAtlases/resolveDrawableAtlas 消费。
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
	const d2 = makeDrawable('sweater-body', 'topBody', 'b.webp', multi ? 'cutout' : undefined);
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
		outfits: { 'test-outfit': { name: '测试', topBody: ['sweater-body'] } },
	};
	if (multi) {
		rig.atlasPages = [{ id: 'base', file: 'atlas.webp' }, { id: 'cutout', file: 'atlas2.webp' }];
	}
	return rig;
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
		assert.equal(rig.drawables.find((d) => d.id === 'sweater-body').atlas, 'cutout');
		assert.equal(rig.product.pages, 2);
		const report = JSON.parse(readFileSync(join(out, 'chibi', 'build-report.json'), 'utf8'));
		assert.equal(report.pages, 2);
		assert.ok(report.atlases.every((page) => page.pixelEqual === true));

		// 与 M3 runtime core 契约对齐
		const normalized = normalizeAtlases(rig);
		assert.equal(normalized.ok, true, normalized.errors.join(','));
		assert.equal(normalized.legacy, false);
		assert.deepEqual(normalized.atlases.map((atlas) => atlas.id), ['base', 'cutout']);
		assert.equal(resolveDrawableAtlas(rig.drawables.find((d) => d.id === 'sweater-body'), normalized.atlases), 1);
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

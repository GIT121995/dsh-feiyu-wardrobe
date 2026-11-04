/**
 * v2 数据契约：manifest v8（DOM 分层退役）+ 2.5D 生产资产覆盖 + 无 DOM 人物资产/无兜底图。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const SHAPES = ['chibi', 'girl'];

function walk(dir, base = dir) {
	/** @type {string[]} */
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(full, base));
		else files.push(relative(base, full).replace(/\\/g, '/'));
	}
	return files;
}

function readRig(shape) {
	return JSON.parse(readFileSync(join(ROOT, 'art/2d5', shape, 'rig.json'), 'utf8'));
}

test('manifest v8：无 drawOrder / 无 shapes[].layers / 无 items[].layers', () => {
	assert.equal(MANIFEST.version, 8);
	assert.equal('drawOrder' in MANIFEST, false);
	for (const shape of MANIFEST.shapes) {
		assert.equal('layers' in shape, false, `${shape.id} 不应再引用 DOM 图层`);
		assert.deepEqual(Object.keys(shape).sort(), ['bounds', 'desc', 'id', 'name']);
	}
	for (const [category, items] of Object.entries(MANIFEST.items)) {
		for (const item of items) assert.equal('layers' in item, false, `${category}/${item.id} 不应再引用 DOM 图层`);
	}
	// 数据面保留：分类/默认穿搭/背景/特效/台词
	assert.deepEqual(MANIFEST.categories.map((category) => category.id), ['outfits', 'tops', 'bottoms', 'backgrounds', 'effects']);
	assert.ok(MANIFEST.defaults && MANIFEST.defaults.shape);
	assert.ok(Array.isArray(MANIFEST.bubbles) && MANIFEST.bubbles.length > 0);
	assert.ok(MANIFEST.bubbleSets && typeof MANIFEST.bubbleSets === 'object');
});

test('manifest v8：衣柜引用的图标/缩略图/背景文件真实存在且是 WebP', () => {
	for (const [category, items] of Object.entries(MANIFEST.items)) {
		for (const item of items) {
			const picture = item.icon || item.thumb || item.file;
			if (!picture) continue;
			const file = join(ROOT, picture);
			assert.ok(existsSync(file), `${category}/${item.id} 引用的文件不存在：${picture}`);
			assert.ok(statSync(file).size > 512, `${picture} 体积异常`);
			assert.equal(readFileSync(file).subarray(8, 12).toString('latin1'), 'WEBP', `${picture} 应为 WebP`);
		}
	}
});

test('DOM 人物资产与构建工具已移除，且不再被引用', () => {
	// art/{chibi,girl} 目录（素体/手臂/前发/衣物层/face 补丁）必须不存在
	for (const dir of ['art/chibi', 'art/girl']) {
		assert.equal(existsSync(join(ROOT, dir)), false, `DOM 人物资产目录应删除：${dir}`);
	}
	// 全站（页面/数据）不再引用 art/chibi|art/girl 路径
	const files = walk(ROOT).filter((file) => /\.(js|html|css|json)$/.test(file));
	for (const file of files) {
		const text = readFileSync(join(ROOT, file), 'utf8');
		assert.ok(!/art\/(chibi|girl)\//.test(text), `${file} 仍引用 DOM 人物资产`);
	}
	// DOM 构建工具（build_masks/build_wardrobe/prepare_dress/masks）已删除
	const toolsDir = join(ROOT, '..', '..', 'tools');
	for (const name of ['build_masks.py', 'build_wardrobe.py', 'prepare_dress.py', 'masks']) {
		assert.equal(existsSync(join(toolsDir, name)), false, `DOM 构建工具应删除：tools/${name}`);
	}
	assert.ok(existsSync(join(toolsDir, 'build_2d5.py')), '2.5D 构建脚本应保留');
});

test('DIY 成层参考掩膜：仅 diy-ui 使用，非人物渲染资产（Lead 批准迁移）', () => {
	// 3 个掩膜存在（DIY fill-under-hair/拆袖的不可见输入）
	for (const name of ['body', 'hair', 'arms']) {
		const file = join(ROOT, 'art/diy/masks/chibi', `${name}.webp`);
		assert.ok(existsSync(file), `缺少 DIY 参考掩膜：${name}.webp`);
		assert.ok(statSync(file).size > 1024, `${name}.webp 体积异常`);
		assert.equal(readFileSync(file).subarray(8, 12).toString('latin1'), 'WEBP');
	}
	// 除 docs/dress-up/diy-* 外，代码不得引用这些掩膜路径
	const repoFiles = [
		...walk(join(ROOT, '..')).filter((file) => /^[a-z0-9.-]+\.(js|mjs)$/i.test(file)).map((file) => join(ROOT, '..', file)),
		...walk(ROOT).filter((file) => /\.(js|html|css|json)$/.test(file)).map((file) => join(ROOT, file)),
		...walk(join(ROOT, '..', '..', 'lib')).map((file) => join(ROOT, '..', '..', 'lib', file)),
	];
	const offenders = [];
	for (const file of repoFiles) {
		if (/\.json$/.test(file)) continue; // manifest/构建报告不算代码引用
		const text = readFileSync(file, 'utf8');
		if (!text.includes('art/diy/masks')) continue;
		const rel = file.replace(join(ROOT, '..', '..') + '/', '');
		if (!/^docs\/dress-up\/diy-[^/]+\.js$/.test(rel)) offenders.push(rel);
	}
	assert.deepEqual(offenders, [], `DIY 参考掩膜只能被 docs/dress-up/diy-* 使用，越权引用：${offenders.join(', ')}`);
});

test('无兜底图资产：art/static-fallback* 不存在（用户口径：仅文本提示）', () => {
	assert.equal(existsSync(join(ROOT, 'art/static-fallback.webp')), false);
	assert.equal(existsSync(join(ROOT, 'art/static-fallback.png')), false);
	const artFiles = walk(join(ROOT, 'art'));
	assert.deepEqual(artFiles.filter((file) => /static-fallback|fallback/i.test(file)), []);
});

test('2.5D 生产资产覆盖两身形与全部可见服装（含 chibi hoodie）', () => {
	const requiredDrawables = [
		// cutout 素体部件（v2.2）
		'body-head', 'body-torso', 'leg-L', 'arm-upper-L', 'arm-fore-L', 'hand-L', 'seam-fill',
		'hair-front-bangs', 'hair-backfill',
		// 服装部件（6 组合）
		'maid-torso', 'maid-skirt', 'maid-collar', 'maid-apron',
		'sweater-plaid-torso', 'sweater-plaid-skirt', 'sweater-plaid-collar',
		'sweater-pleated-torso', 'sweater-pleated-skirt',
		'hoodie-plaid-torso', 'hoodie-plaid-skirt',
		'hoodie-pleated-torso', 'hoodie-pleated-skirt',
		'sailor-plaid-torso', 'sailor-plaid-skirt', 'sailor-plaid-collar',
		'sweater-plaid-sleeve-upper-L', 'sweater-plaid-sleeve-fore-L',
		// face 部件
		'face-eye-L-sclera', 'face-eye-L-iris', 'face-eye-L-lash',
		'face-eye-L-lid-half', 'face-eye-L-lid-closed', 'face-eye-L-lid-smile',
		'face-brow-L', 'face-mouth-neutral', 'face-mouth-open',
	];
	for (const shape of SHAPES) {
		const rig = readRig(shape);
		const ids = new Set(rig.drawables.map((drawable) => drawable.id));
		for (const id of requiredDrawables) assert.ok(ids.has(id), `${shape} 缺少 drawable：${id}`);
		// chibi 有后发层 hair-back；girl 后发由 hair-backfill 承担（无该 id）
		if (shape === 'chibi') assert.ok(ids.has('hair-back'), 'chibi 缺少后发层 hair-back');
		assert.ok(ids.has('hair-backfill'), `${shape} 缺少计算式补边层 hair-backfill`);
		// 套装入口：6 套（含 hoodie-plaid / hoodie-pleated）
		for (const outfit of ['maid', 'sweater-plaid', 'sweater-pleated', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid']) {
			assert.ok(rig.outfits[outfit], `${shape} 缺少套装 ${outfit}`);
			for (const slot of ['topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar']) {
				for (const id of rig.outfits[outfit][slot] || []) assert.ok(ids.has(id), `${shape}/${outfit}.${slot} 引用缺失 drawable ${id}`);
			}
		}
		// 图集 + 构建报告 + 紧凑 rig 均存在
		for (const file of ['rig.json', 'atlas.webp', 'build-report.json']) {
			assert.ok(existsSync(join(ROOT, 'art/2d5', shape, file)), `缺少 art/2d5/${shape}/${file}`);
		}
		const atlas = readFileSync(join(ROOT, 'art/2d5', shape, 'atlas.webp'));
		assert.equal(atlas.subarray(0, 4).toString('latin1'), 'RIFF');
		assert.equal(atlas.subarray(8, 12).toString('latin1'), 'WEBP');
	}
});

test('manifest v8 的 DIY 声明与资产仍在（DIY 后端保留，渲染改静态贴片）', () => {
	const diy = MANIFEST.diy;
	assert.ok(diy && typeof diy === 'object');
	assert.equal(diy.enabled, false, 'DIY 仍默认关闭');
	assert.equal(diy.shape, 'chibi');
	assert.equal(diy.baseRef, 'art/diy/base-chibi.png');
	assert.ok(existsSync(join(ROOT, diy.baseRef)), 'DIY 素体参考图应随包存在');
	assert.match(diy.note, /静态贴片|无骨骼动画/);
});

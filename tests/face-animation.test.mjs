import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';
import {
	FACE_CANVAS,
	FACE_PATCHES,
	FACE_PATCH_KEYS,
	FACE_TIMING,
	facePatchOf,
	facePatchStyle,
	facePatchesOf,
	randomBetween,
} from '../docs/dress-up/wardrobe-core.js';

/**
 * B1-lite 脸部动画：资产 + 纯函数测试。
 *
 * 资产是 675×1200 画布上的裁剪补丁（透明底 WebP），坐标写在 wardrobe-core.FACE_PATCHES 里，
 * 运行时由 app.js 按百分比叠在 .figure 上；不进 manifest.drawOrder。
 */

const ROOT = dressUpRoot();
const SHAPES = ['chibi', 'girl'];

/** 解析 WebP 容器里的画布尺寸 / 是否带 alpha（支持 VP8X / VP8L / VP8）。 */
function webpInfo(bytes) {
	assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', '不是 RIFF 文件');
	assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', '不是 WebP 文件');
	const chunk = bytes.subarray(12, 16).toString('latin1');
	if (chunk === 'VP8X') {
		const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
		const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
		return { width, height, alpha: (bytes[20] & 0x10) !== 0, format: chunk };
	}
	if (chunk === 'VP8L') {
		const bits = bytes.readUInt32LE(21);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), alpha: true, format: chunk };
	}
	if (chunk === 'VP8 ') {
		return {
			width: bytes.readUInt16LE(26) & 0x3fff,
			height: bytes.readUInt16LE(28) & 0x3fff,
			alpha: false,
			format: chunk,
		};
	}
	throw new Error(`未知 WebP chunk：${chunk}`);
}

/** 逐身形 × 补丁 key 产出 [shape, key, patch]。 */
function* patchEntries() {
	for (const shape of SHAPES) {
		for (const key of FACE_PATCH_KEYS) yield [shape, key, FACE_PATCHES[shape][key]];
	}
}

/* ---------------- 资产：两身形 × 4 补丁齐全 ---------------- */

test('脸部补丁：两身形 × 4 个 key 齐全，路径规范且不混入 manifest 槽位', () => {
	assert.deepEqual(Object.keys(FACE_PATCHES).sort(), SHAPES, 'FACE_PATCHES 应覆盖 chibi / girl 两种身形');
	for (const shape of SHAPES) {
		assert.deepEqual(
			Object.keys(FACE_PATCHES[shape]).sort(),
			[...FACE_PATCH_KEYS].sort(),
			`${shape} 应有 eyeBlink / eyeSmile / mouthMid / mouthOpen 四个补丁`,
		);
		for (const key of FACE_PATCH_KEYS) {
			const patch = FACE_PATCHES[shape][key];
			assert.equal(
				patch.file,
				`art/${shape}/face/${key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)}.webp`,
				`${shape}/${key} 的补丁路径应规整放在 art/${shape}/face/ 下`,
			);
			assert.ok(!patch.file.includes('layers/'), `${shape}/${key} 不应占用 manifest 的衣服图层目录`);
		}
	}
});

test('脸部补丁文件：存在、可解码为 WebP、带 alpha、尺寸与常量一致、体积合理', () => {
	for (const [shape, key, patch] of patchEntries()) {
		const file = join(ROOT, patch.file);
		assert.ok(existsSync(file), `${shape}/${key}: 缺文件 ${patch.file}`);
		const bytes = readFileSync(file);
		const info = webpInfo(bytes);
		assert.ok(info.alpha, `${shape}/${key}: 补丁必须是透明底（带 alpha 的 WebP）`);
		assert.equal(info.width, patch.w, `${shape}/${key}: 图片宽 ${info.width} 应等于常量 w=${patch.w}`);
		assert.equal(info.height, patch.h, `${shape}/${key}: 图片高 ${info.height} 应等于常量 h=${patch.h}`);
		// 裁剪补丁：宽高都在脸/嘴局部范围；体积走 lossy q95（<64KB/张，远小于整幅 675×1200 图层）
		assert.ok(info.width >= 16 && info.width <= 500, `${shape}/${key}: 宽 ${info.width} 不合理`);
		assert.ok(info.height >= 16 && info.height <= 400, `${shape}/${key}: 高 ${info.height} 不合理`);
		assert.ok(bytes.byteLength >= 1024, `${shape}/${key}: 文件过小（可能损坏）：${bytes.byteLength}B`);
		assert.ok(bytes.byteLength <= 64 * 1024, `${shape}/${key}: 补丁过大：${bytes.byteLength}B`);
	}
});

test('脸部补丁矩形：落在 675×1200 画布内，且不同身形/不同补丁不串位', () => {
	for (const [shape, key, patch] of patchEntries()) {
		for (const value of [patch.x, patch.y, patch.w, patch.h]) {
			assert.ok(Number.isFinite(value), `${shape}/${key}: 坐标必须是有限数，得到 ${value}`);
		}
		assert.ok(patch.w > 0 && patch.h > 0, `${shape}/${key}: 宽高必须为正`);
		assert.ok(patch.x >= 0 && patch.y >= 0, `${shape}/${key}: 左上角不能为负`);
		assert.ok(patch.x + patch.w <= FACE_CANVAS.width, `${shape}/${key}: 右边界超出画布`);
		assert.ok(patch.y + patch.h <= FACE_CANVAS.height, `${shape}/${key}: 下边界超出画布`);
	}
	// 同一身形的眼部/嘴部补丁应分布在上半张脸（头发下方），不能跑到身体上
	for (const shape of SHAPES) {
		const eye = FACE_PATCHES[shape].eyeBlink;
		const mouth = FACE_PATCHES[shape].mouthMid;
		assert.ok(eye.y + eye.h < FACE_CANVAS.height * 0.5, `${shape}: 眼部补丁应在画布上半部分`);
		assert.ok(mouth.y > eye.y, `${shape}: 嘴部补丁应在眼部补丁下方`);
	}
});

/* ---------------- 纯函数 ---------------- */

test('facePatchStyle：把 675 画布像素矩形换算成百分比定位', () => {
	const style = facePatchStyle(FACE_PATCHES.girl.eyeBlink);
	assert.ok(style, '合法补丁应返回样式');
	assert.equal(style.left, `${Number(((249.61 / 675) * 100).toFixed(4))}%`);
	assert.equal(style.top, `${Number(((226.17 / 1200) * 100).toFixed(4))}%`);
	assert.equal(style.width, `${Number(((189 / 675) * 100).toFixed(4))}%`);
	assert.equal(style.height, `${Number(((88 / 1200) * 100).toFixed(4))}%`);
	for (const value of Object.values(style)) assert.match(value, /^\d+(\.\d+)?%$/, `定位值应是百分比字符串：${value}`);
	assert.equal(facePatchStyle(null), null);
	assert.equal(facePatchStyle(undefined), null);
});

test('facePatchesOf / facePatchOf：按身形取表，缺失时回退第一个身形且不抛错', () => {
	assert.equal(facePatchesOf('girl'), FACE_PATCHES.girl);
	assert.equal(facePatchesOf('chibi'), FACE_PATCHES.chibi);
	// 未知 / 空身形回退（与 resolveLayers 的 findShape 容错口径一致）
	assert.equal(facePatchesOf('unknown-shape'), FACE_PATCHES.girl);
	assert.equal(facePatchesOf(null), FACE_PATCHES.girl);
	assert.equal(facePatchesOf(undefined), FACE_PATCHES.girl);

	assert.equal(facePatchOf('chibi', 'mouthOpen'), FACE_PATCHES.chibi.mouthOpen);
	assert.equal(facePatchOf('girl', 'eyeSmile'), FACE_PATCHES.girl.eyeSmile);
	assert.equal(facePatchOf('girl', 'nope'), null);
	assert.equal(facePatchOf(undefined, 'eyeBlink'), FACE_PATCHES.girl.eyeBlink);
});

test('randomBetween：闭区间取整、参数顺序可反、可注入随机源（定时器不会 0 间隔/越界）', () => {
	assert.equal(randomBetween(2000, 6000, () => 0), 2000, 'random=0 应取下界');
	assert.equal(randomBetween(2000, 6000, () => 0.999999), 6000, 'random≈1 应取上界');
	assert.equal(randomBetween(6000, 2000, () => 0), 2000, '参数写反应自动交换');
	assert.equal(randomBetween(100, 100, () => 0.5), 100, 'min=max 时返回该值');
	for (let i = 0; i < 200; i += 1) {
		const value = randomBetween(FACE_TIMING.blinkMin, FACE_TIMING.blinkMax);
		assert.ok(Number.isInteger(value), `眨眼间隔应为整数毫秒，得到 ${value}`);
		assert.ok(value >= FACE_TIMING.blinkMin && value <= FACE_TIMING.blinkMax, `眨眼间隔越界：${value}`);
	}
});

test('FACE_TIMING：眨眼 2–6s / 闭眼 ~110ms / 口型 ~130ms / 笑眼 20–40s 持续 1.2s', () => {
	const timing = FACE_TIMING;
	assert.ok(timing.blinkMin >= 1000 && timing.blinkMin < timing.blinkMax, '眨眼区间应合理');
	assert.ok(timing.blinkMax <= 10000, '眨眼间隔上限不应太离谱');
	assert.ok(timing.blinkClose >= 60 && timing.blinkClose <= 200, '闭眼时长应 ~110ms 量级');
	assert.ok(timing.mouthPeriod >= 80 && timing.mouthPeriod <= 200, '口型切换应 ~130ms 量级');
	assert.ok(timing.smileMin >= 10000 && timing.smileMin < timing.smileMax, '笑眼区间应合理');
	assert.ok(timing.smileHold >= 500 && timing.smileHold <= 3000, '笑眼持续应 ~1.2s 量级');
});

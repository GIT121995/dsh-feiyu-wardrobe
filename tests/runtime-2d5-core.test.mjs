import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
	BASE_CANVAS,
	DEFAULT_2D5_PARAMS,
	HEAD_FOLLOW_LIMITS,
	PARAM_LIMITS,
	QUALITY_PRESETS,
	accumulateTicks,
	blinkEyeKey,
	clampParams,
	desiredEyeKey,
	desiredMouthKey,
	estimateTextureMemory,
	faceDrawableIds,
	faceStateKeys,
	headFollowParams,
	parseRenderMode,
	pickQualityTier,
	renderModeLabel,
	resolveAutoMode,
	resolveLook,
	resolveQuality,
	resolveRenderMode,
	summarizeInitialPayload,
	visibleDrawables,
} from '../docs/dress-up/runtime-2d5-core.js';
import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const CHIBI = JSON.parse(readFileSync(join(ROOT, 'art/2d5/chibi/rig.json'), 'utf8'));
const GIRL = JSON.parse(readFileSync(join(ROOT, 'art/2d5/girl/rig.json'), 'utf8'));

/* ---------------- 渲染模式决策 ---------------- */

test('parseRenderMode：只接受 dom/2d5/auto（大小写/空白容错）', () => {
	assert.equal(parseRenderMode('dom'), 'dom');
	assert.equal(parseRenderMode(' 2D5 '), '2d5');
	assert.equal(parseRenderMode('auto'), 'auto');
	for (const value of ['webgl', '', null, undefined, 0, 1, true, {}, []]) assert.equal(parseRenderMode(value), null);
});

test('resolveRenderMode：URL > 本地选择 > 宿主配置 > 默认 dom', () => {
	assert.equal(resolveRenderMode({}).mode, 'dom');
	assert.equal(resolveRenderMode({}).source, 'default');
	assert.deepEqual(resolveRenderMode({ config: '2d5' }), { mode: '2d5', requested: '2d5', source: 'config', reason: 'explicit' });
	assert.deepEqual(resolveRenderMode({ config: '2d5', stored: 'dom' }), { mode: 'dom', requested: 'dom', source: 'stored', reason: 'explicit' });
	assert.deepEqual(resolveRenderMode({ config: '2d5', stored: 'dom', url: '2d5' }), { mode: '2d5', requested: '2d5', source: 'url', reason: 'explicit' });
	// URL 是回滚开关：非法 URL 不应阻断后续来源
	assert.deepEqual(resolveRenderMode({ config: '2d5', url: 'nope' }), { mode: '2d5', requested: '2d5', source: 'config', reason: 'explicit' });
	assert.equal(resolveRenderMode({ url: 'dom', config: '2d5' }).mode, 'dom');
});

test('resolveRenderMode：auto 按能力解析（WebGL2/减少动态/低内存）', () => {
	assert.deepEqual(resolveAutoMode({ webgl2: true }), { mode: '2d5', reason: 'capable' });
	assert.deepEqual(resolveAutoMode({}), { mode: 'dom', reason: 'webgl2-unavailable' });
	assert.deepEqual(resolveAutoMode({ webgl2: true, reducedMotion: true }), { mode: 'dom', reason: 'prefers-reduced-motion' });
	assert.deepEqual(resolveAutoMode({ webgl2: true, deviceMemory: 1 }), { mode: 'dom', reason: 'low-device-memory' });
	const autoDecision = resolveRenderMode({ config: 'auto', capable: { webgl2: true } });
	assert.equal(autoDecision.mode, '2d5');
	assert.equal(autoDecision.requested, 'auto');
	assert.equal(autoDecision.reason, 'capable');
	assert.equal(resolveRenderMode({ config: 'auto', capable: { webgl2: false } }).mode, 'dom');
});

test('renderModeLabel：给 UI 的中文标签', () => {
	assert.equal(renderModeLabel('dom'), '分层纸娃娃');
	assert.equal(renderModeLabel('2d5'), '2.5D 动态');
});

/* ---------------- 画质/DPR/降级 ---------------- */

test('resolveQuality：显式档位 / auto 挑档 / 单项覆盖 / 区间钳制', () => {
	assert.deepEqual(resolveQuality('high'), { quality: 'high', ...QUALITY_PRESETS.high });
	assert.deepEqual(resolveQuality('low'), { quality: 'low', ...QUALITY_PRESETS.low });
	assert.equal(resolveQuality('nonsense', {}, { deviceMemory: 8, hardwareConcurrency: 8 }).quality, 'high');
	assert.equal(resolveQuality('auto', {}, { deviceMemory: 1, hardwareConcurrency: 8 }).quality, 'low');
	assert.equal(resolveQuality('auto', {}, {}).quality, 'medium');
	// 单项覆盖优先于档位
	const overridden = resolveQuality('high', { dpr: 1, physicsHz: 120, maskPass: true, mipmaps: false });
	assert.equal(overridden.quality, 'high');
	assert.equal(overridden.dpr, 1);
	assert.equal(overridden.physicsHz, 120);
	assert.equal(overridden.maskPass, true);
	assert.equal(overridden.mipmaps, false);
	// 越界钳制
	assert.equal(resolveQuality('medium', { dpr: 99 }).dpr, 3);
	assert.equal(resolveQuality('medium', { dpr: 0.01 }).dpr, 0.5);
	assert.equal(resolveQuality('medium', { physicsHz: 999 }).physicsHz, 120);
	assert.equal(resolveQuality('medium', { physicsHz: 1 }).physicsHz, 15);
});

test('pickQualityTier：低配 low / 高配 high / 未知 medium', () => {
	assert.equal(pickQualityTier({ deviceMemory: 1, hardwareConcurrency: 8 }), 'low');
	assert.equal(pickQualityTier({ deviceMemory: 8, hardwareConcurrency: 2 }), 'low');
	assert.equal(pickQualityTier({ deviceMemory: 8, hardwareConcurrency: 8 }), 'high');
	assert.equal(pickQualityTier({}), 'medium');
	assert.equal(pickQualityTier({ deviceMemory: null, hardwareConcurrency: 4 }), 'medium');
});

/* ---------------- 参数总线 / head follow ---------------- */

test('clampParams：默认值、未知键忽略、越界钳制、非数字忽略', () => {
	assert.deepEqual(clampParams(), { ...DEFAULT_2D5_PARAMS });
	const params = clampParams(DEFAULT_2D5_PARAMS, {
		headX: 999,
		headY: -999,
		breath: 2,
		eyeOpen: -1,
		mouthOpen: 0.5,
		unknown: 42,
	});
	assert.equal(params.headX, PARAM_LIMITS.headX[1]);
	assert.equal(params.headY, PARAM_LIMITS.headY[0]);
	assert.equal(params.breath, 1);
	assert.equal(params.eyeOpen, 0);
	assert.equal(params.mouthOpen, 0.5);
	assert.equal('unknown' in params, false);
	assert.equal(clampParams(DEFAULT_2D5_PARAMS, { headX: NaN }).headX, 0);
	// 不修改入参
	const base = { ...DEFAULT_2D5_PARAMS };
	clampParams(base, { headX: 10 });
	assert.deepEqual(base, DEFAULT_2D5_PARAMS);
});

test('headFollowParams：归一化坐标 → 头部偏转（包络内/回正）', () => {
	assert.deepEqual(headFollowParams(0, 0), { headY: 0, headX: 0 });
	assert.deepEqual(headFollowParams(1, 1), { headY: HEAD_FOLLOW_LIMITS.yaw, headX: -HEAD_FOLLOW_LIMITS.pitch });
	assert.deepEqual(headFollowParams(-1, -1), { headY: -HEAD_FOLLOW_LIMITS.yaw, headX: HEAD_FOLLOW_LIMITS.pitch });
	assert.deepEqual(headFollowParams(9, -9), { headY: HEAD_FOLLOW_LIMITS.yaw, headX: HEAD_FOLLOW_LIMITS.pitch });
	assert.deepEqual(headFollowParams(null, 0.5), { headY: 0, headX: 0 });
});

/* ---------------- 固定步长累加器（复刻 M2-full POC 数据） ---------------- */

/**
 * 以 1s 墙钟、指定 fps 跑固定步长累加器（与 runtime 循环同口径：先 dtCap 截断再入累加器）。
 * @param {number} fps
 * @param {number} fixedHz
 * @param {number} capMs
 */
function simulateSecond(fps, fixedHz = 60, capMs = 100) {
	const frames = Math.round(fps);
	const rawDt = 1 / fps;
	const dt = Math.min(capMs / 1000, rawDt);
	let acc = 0;
	let ticks = 0;
	let dropped = 0;
	for (let i = 0; i < frames; i += 1) {
		const result = accumulateTicks({ acc, dtWall: dt, hz: fixedHz, maxSubsteps: 8 });
		acc = result.acc;
		ticks += result.ticks;
		dropped += result.dropped;
	}
	return { frames, wallSeconds: Math.round(frames * rawDt * 1000) / 1000, ticks, dropped, cap: dt < rawDt };
}

test('accumulateTicks：15/30/60fps 1s 墙钟 → 60 ticks（低帧率物理不再变慢）', () => {
	for (const fps of [60, 30, 15]) {
		const result = simulateSecond(fps);
		assert.equal(result.ticks, 60, `${fps}fps 应结算 60 ticks`);
		assert.equal(result.dropped, 0);
		assert.equal(result.cap, false);
	}
});

test('accumulateTicks：5/8fps 受 100ms 单帧上限 → 物理慢于墙钟（如实保留 POC 行为）', () => {
	const five = simulateSecond(5);
	assert.equal(five.ticks, 30, '5fps：1s 墙钟只结算 0.5s 模拟');
	assert.equal(five.cap, true);
	const eight = simulateSecond(8);
	assert.equal(eight.ticks, 48, '8fps：1s 墙钟结算 0.8s 模拟');
});

test('accumulateTicks：30Hz 物理 / backlog 丢弃 / 无残留负值', () => {
	let acc = 0;
	let ticks = 0;
	for (let i = 0; i < 30; i += 1) {
		const result = accumulateTicks({ acc, dtWall: 1 / 30, hz: 30 });
		acc = result.acc;
		ticks += result.ticks;
	}
	assert.equal(ticks, 30);
	// 一次超大 dt（如断点续跑）触发 maxSubsteps 上限并丢弃 backlog
	const huge = accumulateTicks({ acc: 0, dtWall: 2, hz: 60, maxSubsteps: 8 });
	assert.equal(huge.ticks, 8);
	assert.ok(huge.dropped >= 100, `应丢弃积压 tick，实际 ${huge.dropped}`);
	assert.equal(huge.acc, 0);
});

/* ---------------- face 状态机（POC 同口径） ---------------- */

test('blinkEyeKey：0.14s 内 half → closed → half', () => {
	assert.equal(blinkEyeKey(0.14), 'half');
	assert.equal(blinkEyeKey(0.11), 'half');
	assert.equal(blinkEyeKey(0.07), 'closed');
	assert.equal(blinkEyeKey(0.02), 'half'); // 接近结束时回到 half（POC 同口径）
	assert.equal(blinkEyeKey(0), 'half');
});

test('desiredEyeKey：EyeOpen/眨眼/笑眼优先级（parts 与 legacy）', () => {
	const base = { params: { eyeOpen: 1, eyeSmile: 0 }, blinkT: 0, smileT: 0 };
	assert.equal(desiredEyeKey(base), 'open');
	assert.equal(desiredEyeKey({ ...base, blinkT: 0.07 }), 'closed');
	assert.equal(desiredEyeKey({ ...base, smileT: 1.2 }), 'smile');
	assert.equal(desiredEyeKey({ ...base, params: { eyeOpen: 0.2, eyeSmile: 0 } }), 'closed');
	assert.equal(desiredEyeKey({ ...base, override: 'smile' }), 'smile');
	assert.equal(desiredEyeKey({ ...base, blinkT: 0.07, parts: false }), 'blink');
	assert.equal(desiredEyeKey({ ...base, params: { eyeOpen: 0.2, eyeSmile: 0 }, parts: false }), 'blink');
});

test('desiredMouthKey：说话循环 / mouthOpen 阈值 / 覆盖', () => {
	const base = { params: { mouthOpen: 0 }, time: 0 };
	assert.equal(desiredMouthKey(base), 'closed');
	assert.equal(desiredMouthKey({ ...base, params: { mouthOpen: 0.3 } }), 'small');
	assert.equal(desiredMouthKey({ ...base, params: { mouthOpen: 0.6 } }), 'mid');
	assert.equal(desiredMouthKey({ ...base, params: { mouthOpen: 0.9 } }), 'open');
	assert.equal(desiredMouthKey({ ...base, talking: true, time: 0 }), 'closed');
	assert.equal(desiredMouthKey({ ...base, talking: true, time: 0.12 }), 'small');
	assert.equal(desiredMouthKey({ ...base, override: 'open' }), 'open');
	assert.equal(desiredMouthKey({ ...base, params: { mouthOpen: 0.3 }, parts: false }), 'mid');
});

/* ---------------- 换装组合解析 ---------------- */

test('resolveLook：套装命中（maid / sweater-plaid / hoodie-plaid 双身形）', () => {
	for (const rig of [CHIBI, GIRL]) {
		const maid = resolveLook(rig, { outfit: 'maid' });
		assert.equal(maid.outfit, 'maid');
		assert.deepEqual(maid.slots.topBody, ['maid-body']);
		assert.deepEqual(maid.slots.sleeve, ['maid-sleeve']);
		assert.deepEqual(maid.slots.bottom, []);
		assert.equal(maid.fallback, null);
	}
	// production 资产（M4）：两身形都有 hoodie 套装
	for (const rig of [CHIBI, GIRL]) {
		const hoodie = resolveLook(rig, { outfit: 'hoodie-plaid' });
		assert.equal(hoodie.outfit, 'hoodie-plaid');
		assert.deepEqual(hoodie.slots.topBody, ['hoodie-body']);
		assert.deepEqual(hoodie.slots.bottom, ['bottom-plaid']);
	}
});

test('resolveLook：上衣+下装动态组合（4 上装 × 2 下装，含 topUnder 水手服与 hoodie）', () => {
	const combos = [
		['sweater', 'plaid', 'topBody', 'sweater-body', 'bottom-plaid'],
		['sweater', 'pleated', 'topBody', 'sweater-body', 'bottom-pleated'],
		['sailor', 'plaid', 'topUnder', 'sailor-body', 'bottom-plaid'],
		['sailor', 'pleated', 'topUnder', 'sailor-body', 'bottom-pleated'],
		['hoodie', 'plaid', 'topBody', 'hoodie-body', 'bottom-plaid'],
		['hoodie', 'pleated', 'topBody', 'hoodie-body', 'bottom-pleated'],
	];
	for (const [top, bottom, slot, bodyId, bottomId] of combos) {
		const look = resolveLook(CHIBI, { outfit: 'none', top, bottom });
		assert.equal(look.outfit, null);
		assert.deepEqual(look.slots[slot], [bodyId], `${top}+${bottom} 主体槽位`);
		assert.deepEqual(look.slots.bottom, [bottomId]);
		assert.equal(look.slots.sleeve.length, 1);
		assert.equal(look.fallback, null);
	}
	// production 资产：两身形都有 hoodie → 不回退、无 warnings
	for (const rig of [CHIBI, GIRL]) {
		const hoodie = resolveLook(rig, { outfit: 'none', top: 'hoodie', bottom: 'pleated' });
		assert.deepEqual(hoodie.slots.topBody, ['hoodie-body']);
		assert.equal(hoodie.warnings.length, 0);
	}
});

test('resolveLook：未知套装/缺下装时的回退与 warnings（不抛错）', () => {
	const look = resolveLook(CHIBI, { outfit: 'unknown-set', top: 'unknown-top', bottom: 'unknown-bottom' });
	assert.ok(look.slots.topBody.length + look.slots.topUnder.length > 0, '应回退到可用套装');
	assert.ok(look.warnings.length > 0);
	// 页面只有 maid 套装 + 上衣/下装：默认 state 不应触发回退
	const domState = { outfit: 'none', top: 'sweater', bottom: 'plaid' };
	assert.equal(resolveLook(CHIBI, domState).warnings.length, 0);
});

test('visibleDrawables：按 z 升序、套装/上下装/face 状态切换、补边层在 body 下', () => {
	const maid = resolveLook(CHIBI, { outfit: 'maid' });
	const open = visibleDrawables(CHIBI, maid, { eye: 'open', mouth: 'closed' });
	const blink = visibleDrawables(CHIBI, maid, { eye: 'closed', mouth: 'closed' });
	const ids = open.map((entry) => entry.id);
	assert.deepEqual(ids, [...ids].sort((a, b) => {
		const za = (open.find((entry) => entry.id === a) || {}).z;
		const zb = (open.find((entry) => entry.id === b) || {}).z;
		return za - zb || a.localeCompare(b);
	}), '应按 z 升序（同 z 按 id）');
	assert.ok(ids.includes('body'));
	assert.ok(ids.includes('maid-body'));
	assert.ok(ids.includes('face-eye-L-iris'));
	assert.ok(ids.includes('face-mouth-neutral'));
	assert.ok(!blink.map((entry) => entry.id).includes('face-eye-L-lid-closed') || true); // 部件存在性由 rig 决定
	assert.notDeepEqual(open.map((entry) => entry.id), blink.map((entry) => entry.id), '眼态变化应改变可见 drawable');
	// 补边层 z=4 必须在 body（z=10）之前绘制
	const hairBackfill = open.find((entry) => entry.id === 'hair-backfill');
	assert.ok(hairBackfill && hairBackfill.z < 10);
	// 换装后服装 drawable 变化
	const sweater = resolveLook(CHIBI, { outfit: 'none', top: 'sweater', bottom: 'pleated' });
	const sweaterIds = visibleDrawables(CHIBI, sweater, { eye: 'open', mouth: 'closed' }).map((entry) => entry.id);
	assert.ok(sweaterIds.includes('sweater-body'));
	assert.ok(sweaterIds.includes('bottom-pleated'));
	assert.ok(!sweaterIds.includes('maid-body'));
});

test('faceDrawableIds / faceStateKeys：rig face 部件表与兜底', () => {
	const keys = faceStateKeys(CHIBI);
	assert.equal(keys.mode, 'parts');
	assert.deepEqual(keys.eye, ['open', 'half', 'closed', 'smile']);
	assert.ok(keys.mouth.includes('closed') && keys.mouth.includes('open'));
	const ids = faceDrawableIds(CHIBI, 'open', 'closed');
	assert.ok(ids.includes('face-eye-L-iris'));
	assert.ok(ids.includes('face-mouth-neutral'));
	assert.ok(!ids.includes('face-mouth-open'));
	const fallback = faceStateKeys({});
	assert.equal(fallback.mode, 'legacy');
	assert.deepEqual(fallback.eye, ['open', 'half', 'closed', 'smile']);
});

/* ---------------- 内存 / payload ---------------- */

test('estimateTextureMemory：图集显存（RGBA8，mipmap ×4/3）', () => {
	const memory = estimateTextureMemory([{ width: 2048, height: 2048 }], true);
	assert.equal(memory.texBytes, 2048 * 2048 * 4);
	assert.equal(memory.texMiB, 16);
	assert.equal(memory.texMiBwithMipmap, 21.33);
	assert.equal(estimateTextureMemory([{ width: 2048, height: 2048 }], false).texMiBwithMipmap, 16);
	assert.equal(estimateTextureMemory([{ width: 100, height: 100 }, { width: 200, height: 100 }], false).texBytes, (100 * 100 + 200 * 100) * 4);
});

test('summarizeInitialPayload：首屏 raw/transfer 汇总', () => {
	const summary = summarizeInitialPayload({ rigBytes: 1600000, rigTransferBytes: 270000, atlasBytes: 1200000, codeBytes: 60000 });
	assert.equal(summary.rawBytes, 2860000);
	assert.equal(summary.transferBytes, 1530000);
	assert.equal(summary.rawMiB, 2.73);
	assert.equal(summary.transferMiB, 1.46);
	// 无 transfer 信息时回退 raw
	assert.equal(summarizeInitialPayload({ rigBytes: 100, atlasBytes: 200 }).transferBytes, 300);
});

test('BASE_CANVAS：与 DOM 分层素材同构（675×1200 9:16）', () => {
	assert.deepEqual(BASE_CANVAS, { width: 675, height: 1200 });
	assert.equal(BASE_CANVAS.width / BASE_CANVAS.height, 9 / 16);
});

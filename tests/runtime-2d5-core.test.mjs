import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
	BASE_CANVAS,
	DEFAULT_2D5_PARAMS,
	HEAD_FOLLOW_LIMITS,
	OUTFIT_SLOTS,
	PARAM_LIMITS,
	QUALITY_PRESETS,
	V3_OUTFIT_LAYERS,
	accumulateTicks,
	assetDirForTier,
	blinkEyeKey,
	clampParams,
	desiredEyeKey,
	desiredMouthKey,
	drawableIdsOf,
	estimateTextureMemory,
	faceDrawableIds,
	normalizeDiyPack,
	registerDiyPack,
	unregisterDiyPack,
	carryDiyPacks,
	resolveTierPlan,
	tierLoadPlan,
	tierUpgradeSettled,
	faceStateKeys,
	headFollowParams,
	pickQualityTier,
	resolveAssetTier,
	resolveLook,
	resolveQuality,
	summarizeInitialPayload,
	visibleDrawables,
} from '../docs/dress-up/runtime-2d5-core.js';
import { defaultState, normalizeState } from '../docs/dress-up/wardrobe-core.js';
import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const CHIBI = JSON.parse(readFileSync(join(ROOT, 'art/2d5/chibi/rig.json'), 'utf8'));
const GIRL = JSON.parse(readFileSync(join(ROOT, 'art/2d5/girl/rig.json'), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

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

/**
 * v3.0 整层 outfit rig（mock，PLAN §2）：每套 outfit 只有 2 个 drawable：
 *   `{combo}-top`（slot=topBody，z=64）与 `{combo}-skirt`（slot=bottom，z=30）；
 * 不再有 collar/sleeve/sleeveUpper/sleeveFore 分件（v3 真实 dist 由 Phase 2A 产出，单测不等 dist）。
 */
function makeV3Rig() {
	/** @type {any[]} */
	const drawables = [
		{ id: 'hair-back', slot: 'hairBack', z: 5 },
		{ id: 'body-torso', slot: 'body', z: 10 },
		{ id: 'arm-upper-L', slot: 'armUpper', z: 45 },
		{ id: 'arm-fore-L', slot: 'armFore', z: 48 },
		{ id: 'hand-L', slot: 'hand', z: 65 },
		{ id: 'hair-front-bangs', slot: 'hairFront', z: 70 },
	];
	/** @type {Record<string, any>} */
	const outfits = {};
	for (const [combo, layers] of Object.entries(V3_OUTFIT_LAYERS)) {
		drawables.push({ id: layers.top, slot: 'topBody', z: 64 });
		drawables.push({ id: layers.skirt, slot: 'bottom', z: 30 });
		outfits[combo] = { name: combo, topBody: [layers.top], bottom: [layers.skirt] };
	}
	return {
		drawables,
		slots: {
			body: ['body-torso'],
			armUpper: ['arm-upper-L'],
			armFore: ['arm-fore-L'],
			hand: ['hand-L'],
			hairBack: ['hair-back'],
			hairFront: ['hair-front-bangs'],
		},
		outfits,
		defaults: { outfit: 'maid' },
	};
}

const V3_COMBOS = Object.keys(V3_OUTFIT_LAYERS);
const V3_LAYER_IDS = new Set(Object.values(V3_OUTFIT_LAYERS).flatMap((layers) => [layers.top, layers.skirt]));

test('resolveLook：v3 单层 outfit 命中（每套 topBody/bottom 各 1 项；分件槽位缺省空数组）', () => {
	const rig = makeV3Rig();
	for (const combo of V3_COMBOS) {
		const look = resolveLook(rig, { outfit: combo });
		assert.equal(look.outfit, combo);
		assert.equal(look.fallback, null);
		assert.deepEqual(look.warnings, []);
		assert.deepEqual(look.slots.topBody, [V3_OUTFIT_LAYERS[combo].top], `${combo} top 整层`);
		assert.deepEqual(look.slots.bottom, [V3_OUTFIT_LAYERS[combo].skirt], `${combo} skirt 整层`);
		// v2.x 分件槽位在 v3 全部为空数组 —— 不存在「collar/sleeve 必填」假设
		for (const slot of ['topUnder', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar']) {
			assert.deepEqual(look.slots[slot], [], `${combo}.${slot} 应为空数组`);
		}
	}
	// 只声明 topBody（无 bottom）的单层 outfit 也能命中：缺槽位=空数组，不触发回退
	const topOnlyRig = makeV3Rig();
	topOnlyRig.outfits.maid = { name: 'maid-top-only', topBody: ['maid-top'] };
	const topOnly = resolveLook(topOnlyRig, { outfit: 'maid' });
	assert.equal(topOnly.outfit, 'maid');
	assert.equal(topOnly.fallback, null);
	assert.deepEqual(topOnly.slots.topBody, ['maid-top']);
	assert.deepEqual(topOnly.slots.bottom, []);
});

test('resolveLook：真实 rig 套装命中（v2.7 分件 / v3 整层都成立；按 rig.outfits 逐槽位派生）', () => {
	for (const rig of [CHIBI, GIRL]) {
		const available = drawableIdsOf(rig);
		for (const [outfitId, outfit] of Object.entries(rig.outfits || {})) {
			const look = resolveLook(rig, { outfit: outfitId });
			assert.equal(look.outfit, outfitId);
			assert.equal(look.fallback, null);
			assert.deepEqual(look.warnings, []);
			for (const slot of OUTFIT_SLOTS) {
				const expected = (outfit[slot] || []).filter((id) => available.has(id));
				assert.deepEqual(look.slots[slot], expected, `${rig.shape}/${outfitId}.${slot}`);
			}
			// 整套 outfit（非 base 素体）至少要渲染上衣 + 下装层
			if (Object.keys(outfit).some((key) => key !== 'name')) {
				assert.ok(look.slots.topBody.length + look.slots.topUnder.length > 0, `${rig.shape}/${outfitId} 应有上衣层`);
				assert.ok(look.slots.bottom.length > 0, `${rig.shape}/${outfitId} 应有下装层`);
			}
		}
	}
});

test('resolveLook：v3 rig 上衣+下装动态组合 → 组合 outfit 整层（不再走 legacy GARMENTS）', () => {
	const rig = makeV3Rig();
	for (const [top, bottom] of [['hoodie', 'plaid'], ['hoodie', 'pleated'], ['sailor', 'plaid']]) {
		const comboId = `${top}-${bottom}`;
		const look = resolveLook(rig, { outfit: 'none', top, bottom });
		assert.equal(look.outfit, null);
		assert.equal(look.fallback, null, `${comboId} 不应回退`);
		assert.deepEqual(look.warnings, []);
		assert.deepEqual(look.slots.topBody, [V3_OUTFIT_LAYERS[comboId].top], `${comboId} 上衣整层`);
		assert.deepEqual(look.slots.bottom, [V3_OUTFIT_LAYERS[comboId].skirt], `${comboId} 下装整层`);
	}
	// 无对应组合（sailor+pleated）→ 回退到 rig 默认合法 outfit（不出现半裸 look）
	const missing = resolveLook(rig, { outfit: 'none', top: 'sailor', bottom: 'pleated' });
	assert.ok(missing.warnings.length > 0);
	assert.equal(missing.fallback, 'maid');
	assert.deepEqual(missing.slots.topBody, ['maid-top']);
	assert.deepEqual(missing.slots.bottom, ['maid-skirt']);
});

test('resolveLook：真实 rig 旧上衣+下装动态组合（v2.7/v3 都回退/命中合法 outfit）', () => {
	for (const rig of [CHIBI, GIRL]) {
		const available = drawableIdsOf(rig);
		for (const [top, bottom] of [['hoodie', 'plaid'], ['hoodie', 'pleated'], ['sailor', 'plaid']]) {
			const comboId = `${top}-${bottom}`;
			const combo = rig.outfits[comboId];
			assert.ok(combo, `${rig.shape} 应有组合 ${comboId}`);
			const look = resolveLook(rig, { outfit: 'none', top, bottom });
			assert.equal(look.outfit, null);
			assert.equal(look.fallback, null);
			assert.deepEqual(look.warnings, []);
			for (const slot of OUTFIT_SLOTS) {
				const expected = (combo[slot] || []).filter((id) => available.has(id));
				assert.deepEqual(look.slots[slot], expected, `${rig.shape}/${comboId}.${slot}`);
			}
		}
		// 无组合的旧存档（sailor+pleated）：回退到合法成套 outfit（上有衣、下有裙），不抛错
		const missing = resolveLook(rig, { outfit: 'none', top: 'sailor', bottom: 'pleated' });
		assert.ok(missing.warnings.length > 0);
		assert.ok(missing.slots.topBody.length + missing.slots.topUnder.length > 0, `${rig.shape} 应有上衣层`);
		assert.ok(missing.slots.bottom.length > 0, `${rig.shape} 应有下装层`);
	}
});

test('resolveLook：未知套装/缺下装时的回退与 warnings（不抛错）', () => {
	const look = resolveLook(CHIBI, { outfit: 'unknown-set', top: 'unknown-top', bottom: 'unknown-bottom' });
	assert.ok(look.slots.topBody.length + look.slots.topUnder.length > 0, '应回退到可用套装');
	assert.ok(look.warnings.length > 0);
	// 页面只有 maid 套装 + 上衣/下装：默认 state 不应触发回退
	const domState = { outfit: 'none', top: 'hoodie', bottom: 'plaid' };
	assert.equal(resolveLook(CHIBI, domState).warnings.length, 0);
});

test('resolveLook：v3 rig 旧存档残留（top=sweater / outfit=sweater-*）回退合法 outfit，不抛错', () => {
	const rig = makeV3Rig();
	for (const legacyState of [
		{ outfit: 'sweater-plaid' },
		{ outfit: 'sweater-pleated', top: 'sweater', bottom: 'plaid' },
		{ outfit: 'none', top: 'sweater', bottom: 'pleated' },
	]) {
		const look = resolveLook(rig, legacyState);
		assert.equal(look.fallback, 'maid', `${JSON.stringify(legacyState)} 应回退默认 maid`);
		assert.deepEqual(look.slots.topBody, ['maid-top']);
		assert.deepEqual(look.slots.bottom, ['maid-skirt']);
		assert.ok(look.warnings.length > 0);
		assert.ok(!Object.values(look.slots).flat().some((id) => String(id).includes('sweater')), '不应残留毛衣 drawable');
	}
	// 存档层（normalizeState）先把已下架单品回退成 manifest 默认，再进 runtime：
	const normalized = normalizeState(MANIFEST, { shape: 'chibi', outfit: 'sweater-plaid', top: 'sweater', bottom: 'pleated' });
	assert.equal(normalized.outfit, defaultState(MANIFEST).outfit, '下架套装 → 默认套装');
	assert.equal(normalized.top, defaultState(MANIFEST).top, '下架上衣 → 默认上衣');
	assert.equal(normalized.bottom, 'pleated', '合法下装保留');
});

test('resolveLook：旧 v2.1 rig 上衣缺件回退连帽卫衣（毛衣下架后不再回退毛衣）', () => {
	// v2.1 generic drawable rig（无 cutout 组合套装）：未知上衣 → 回退 hoodie
	const legacyRig = {
		drawables: [
			{ id: 'body-torso', slot: 'body', z: 10 },
			{ id: 'hoodie-body', slot: 'topBody', z: 40 },
			{ id: 'hoodie-sleeve', slot: 'sleeve', z: 60 },
			{ id: 'bottom-plaid', slot: 'bottom', z: 30 },
		],
		outfits: {},
		defaults: { outfit: 'maid' },
	};
	const legacy = resolveLook(legacyRig, { outfit: 'none', top: 'unknown-top', bottom: 'plaid' });
	assert.equal(legacy.fallback, 'partial');
	assert.deepEqual(legacy.slots.topBody, ['hoodie-body']);
	assert.deepEqual(legacy.slots.sleeve, ['hoodie-sleeve']);
	assert.ok(legacy.warnings.some((warning) => warning.startsWith('top:unknown-top→hoodie')), `warnings=${legacy.warnings.join(',')}`);
});

test('visibleDrawables：v3 单层 outfit 按 z 序渲染（skirt30 < body手臂45/48 < top64 < hand65 < hairfront70）', () => {
	const rig = makeV3Rig();
	const look = resolveLook(rig, { outfit: 'maid' });
	const entries = visibleDrawables(rig, look, { eye: 'open', mouth: 'closed' });
	const ids = entries.map((entry) => entry.id);
	const z = (id) => (entries.find((entry) => entry.id === id) || {}).z;
	assert.ok(ids.includes('maid-top') && ids.includes('maid-skirt'), 'v3 整层 top/skirt 都应可见');
	assert.ok(!ids.includes('maid-collar') && !ids.includes('maid-sleeve-upper-L'), '不应引用已退役分件');
	assert.ok(z('maid-skirt') < z('arm-upper-L'), '裙层在 body 手臂之下');
	assert.ok(z('arm-upper-L') < z('maid-top'), 'v3 top（z=64）必须盖住 body 裸手臂（z=45/48）');
	assert.ok(z('maid-top') < z('hand-L'), '手在服装之上');
	assert.ok(z('maid-top') < z('hair-front-bangs'), '前发在服装之上');
	// 按 z 升序（同 z 按 id）
	assert.deepEqual(ids, [...ids].sort((a, b) => z(a) - z(b) || a.localeCompare(b)));
});

test('visibleDrawables：真实 rig 套装/上下装切换 + face 状态、补边层在 body 下（不锁死分件 id）', () => {
	const available = drawableIdsOf(CHIBI);
	const maid = resolveLook(CHIBI, { outfit: 'maid' });
	const open = visibleDrawables(CHIBI, maid, { eye: 'open', mouth: 'closed' });
	const blink = visibleDrawables(CHIBI, maid, { eye: 'closed', mouth: 'closed' });
	const ids = open.map((entry) => entry.id);
	assert.deepEqual(ids, [...ids].sort((a, b) => {
		const za = (open.find((entry) => entry.id === a) || {}).z;
		const zb = (open.find((entry) => entry.id === b) || {}).z;
		return za - zb || a.localeCompare(b);
	}), '应按 z 升序（同 z 按 id）');
	// body/头发/face 常驻层按 rig.slots 派生（v2.7/v3 通用）
	for (const slot of ['body', 'legs', 'armUpper', 'armFore', 'hand', 'hairBack', 'hairFront']) {
		for (const id of (CHIBI.slots && CHIBI.slots[slot]) || []) assert.ok(ids.includes(id), `缺少常驻层 ${slot}:${id}`);
	}
	for (const id of faceDrawableIds(CHIBI, 'open', 'closed')) assert.ok(ids.includes(id), `缺少 face 部件 ${id}`);
	assert.notDeepEqual(open.map((entry) => entry.id), blink.map((entry) => entry.id), '眼态变化应改变可见 drawable');
	// 补边层 z<10 必须在 body 部件之前绘制（hair-backfill 为两身形共用契约）
	const hairBackfill = open.find((entry) => entry.id === 'hair-backfill');
	assert.ok(hairBackfill && hairBackfill.z < 10);
	// 换装后服装 drawable 变化：组合 outfit 的引用应全部可见，且不混入 maid 的服装层
	const combo = resolveLook(CHIBI, { outfit: 'none', top: 'hoodie', bottom: 'pleated' });
	const comboIds = visibleDrawables(CHIBI, combo, { eye: 'open', mouth: 'closed' }).map((entry) => entry.id);
	const comboRefs = OUTFIT_SLOTS.flatMap((slot) => (CHIBI.outfits['hoodie-pleated'][slot] || []).filter((id) => available.has(id)));
	const maidRefs = new Set(OUTFIT_SLOTS.flatMap((slot) => CHIBI.outfits.maid[slot] || []));
	assert.ok(comboRefs.length > 0);
	for (const id of comboRefs) {
		assert.ok(comboIds.includes(id), `hoodie-pleated 应渲染 ${id}`);
		assert.ok(!maidRefs.has(id), `${id} 属于 maid，不应出现在 hoodie-pleated`);
	}
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

test('resolveLook bare（DIY 静态贴片）：只留身体/头发/脸，不渲染任何服装层', () => {
	const look = resolveLook(CHIBI, { bare: true });
	// 旧 4 键语义不变；cutout 新槽位以空数组存在（不渲染）
	for (const slot of ['topUnder', 'bottom', 'topBody', 'sleeve']) {
		assert.deepEqual(look.slots[slot], [], `${slot} 应为空`);
	}
	assert.ok(Object.values(look.slots).every((values) => Array.isArray(values) && values.length === 0));
	assert.equal(look.outfit, null);
	assert.deepEqual(look.warnings, [], 'bare 模式不应产生回退 warnings');
	const ids = visibleDrawables(CHIBI, look, { eye: 'open', mouth: 'closed' }).map((entry) => entry.id);
	assert.ok(ids.includes('body-head') || ids.includes('body-torso'));
	assert.ok(ids.includes('hair-front-bangs'), '应保留头发');
	assert.ok(!ids.some((id) => /maid|sailor|hoodie|bottom-/.test(id)), '不应出现任何服装层');
});

test('BASE_CANVAS：与 DOM 分层素材同构（675×1200 9:16）', () => {
	assert.deepEqual(BASE_CANVAS, { width: 675, height: 1200 });
	assert.equal(BASE_CANVAS.width / BASE_CANVAS.height, 9 / 16);
});

/* ------------------------------------------------------- S3 · DIY 增量 pack --- */

/** 构造一个最小可用 feiyu-diy-pack（2 drawables / 2 纹理，59 骨）。 */
function makeDiyPack(overrides = {}) {
	const drawable = (id, slot, z, texture) => ({
		id, slot, z, role: slot, texture,
		rect: [10, 10, 60, 60], texSize: [10, 10],
		mesh: {
			positions: [[10, 10], [20, 10], [20, 20]],
			uvs: [[0, 0], [1, 0], [1, 1]],
			bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
			weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			deform: [[0, 0], [0, 0], [0, 0]],
			indices: [0, 1, 2],
		},
	});
	return {
		format: 'feiyu-diy-pack', formatVersion: 1, item: 'diy-test-20260101000000',
		name: '测试套装', shape: 'chibi', category: 'top',
		base: { skeletonBones: 59 },
		drawables: [drawable('diy-test-body', 'topBody', 40, 'tex/diy-test-body.webp'),
			drawable('diy-test-sleeve', 'sleeve', 60, 'tex/diy-test-sleeve.webp')],
		outfits: { 'diy-test-20260101000000': { name: '测试套装', topBody: ['diy-test-body'], sleeve: ['diy-test-sleeve'], bottom: [] } },
		...overrides,
	};
}

test('normalizeDiyPack：接受 v1 增量 pack（多 drawable/多纹理），拒绝坏数据', () => {
	const pack = makeDiyPack();
	const ok = normalizeDiyPack(pack, { bones: 59, shape: 'chibi' });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.errors, []);
	assert.equal(ok.packId, 'diy-test-20260101000000');
	assert.deepEqual(ok.textures, ['tex/diy-test-body.webp', 'tex/diy-test-sleeve.webp']);
	assert.deepEqual(ok.outfits['diy-test-20260101000000'].topBody, ['diy-test-body']);

	const bad = [
		[{ format: 'nope' }, 'format_invalid'],
		[{ formatVersion: 2 }, 'version_invalid'],
		[{ base: { skeletonBones: 60 } }, 'skeleton_mismatch'],
		[{ shape: 'girl' }, 'shape_mismatch'],
		[{ outfits: {} }, 'outfit_missing'],
	];
	for (const [patch, expected] of bad) {
		const result = normalizeDiyPack({ ...makeDiyPack(), ...patch }, { bones: 59, shape: 'chibi' });
		assert.equal(result.ok, false, JSON.stringify(patch));
		assert.ok(result.errors.includes(expected), `${expected} 未命中：${result.errors.join(',')}`);
	}
	const brokenMesh = makeDiyPack();
	brokenMesh.drawables[0].mesh.uvs[0] = [2, 0];
	brokenMesh.drawables[0].mesh.indices[0] = 99;
	brokenMesh.drawables[0].mesh.weights[0] = [0.4, 0.4, 0.4, 0.4];
	const meshResult = normalizeDiyPack(brokenMesh, { bones: 59, shape: 'chibi' });
	assert.equal(meshResult.ok, false);
	assert.ok(meshResult.errors.some((error) => error.startsWith('uv_out_of_range') || error.startsWith('index_out_of_range') || error.startsWith('weights_not_normalized')));
});

test('registerDiyPack/unregisterDiyPack：动态 drawable/outfit 注册与回滚，状态引用不破坏', () => {
	const baseDrawables = [{ id: 'body', slot: 'body', z: 10 }];
	const scene = {
		drawables: baseDrawables,
		drawableById: { body: baseDrawables[0] },
		outfits: { maid: { name: 'maid', topBody: ['x'] } },
		bones: [{ id: 'root' }],
		chains: [{ id: 'skirtP0' }],
		stats: { verts: 3, tris: 1 },
	};
	const bonesRef = scene.bones;
	const chainsRef = scene.chains;
	const normalized = normalizeDiyPack(makeDiyPack(), { bones: 59, shape: 'chibi' });
	assert.equal(normalized.ok, true);
	const first = registerDiyPack(scene, 'diy-test-20260101000000', normalized);
	assert.equal(first.ok, true);
	assert.equal(scene.drawables.length, 3);
	assert.equal(scene.drawableById['diy-test-body'].slot, 'topBody');
	assert.ok(scene.outfits['diy-test-20260101000000']);
	assert.equal(scene.diyPacks.size, 1);
	// 同状态引用（add 不重建骨架/物理链）
	assert.equal(scene.bones, bonesRef);
	assert.equal(scene.chains, chainsRef);
	// 重复注册
	const second = registerDiyPack(scene, 'diy-test-20260101000000', normalized);
	assert.equal(second.ok, false);
	assert.equal(second.code, 'pack_exists');
	// 移除
	const removed = unregisterDiyPack(scene, 'diy-test-20260101000000');
	assert.equal(removed.ok, true);
	assert.equal(scene.drawables.length, 1);
	assert.equal(scene.drawableById['diy-test-body'], undefined);
	assert.equal(scene.outfits['diy-test-20260101000000'], undefined);
	assert.equal(scene.diyPacks.size, 0);
	assert.equal(unregisterDiyPack(scene, 'diy-test-20260101000000').ok, false);
});

test('estimateTextureMemory：多纹理 DIY 显存估算（纹理独立、不进 base 图集）', () => {
	const memory = estimateTextureMemory([{ width: 300, height: 320 }, { width: 294, height: 293 }], false);
	assert.ok(memory.texBytes > 0);
	assert.equal(memory.texMiB, Math.round((memory.texBytes / 1048576) * 100) / 100);
	assert.ok(memory.texMiBwithMipmap >= memory.texMiB);
});

/* ---------------- v2.6.1 资产 tier（2x 高 DPI） ---------------- */

test('resolveAssetTier：DPR≥2 + 内存/核数 + 纹理上限才 hi，否则 lo', () => {
	const strong = { deviceMemory: 8, hardwareConcurrency: 8 };
	assert.equal(resolveAssetTier({ device: strong, dpr: 2, maxTextureSize: 8192 }).tier, 'hi');
	assert.equal(resolveAssetTier({ device: strong, dpr: 2.5, maxTextureSize: 8192 }).tier, 'hi');
	assert.equal(resolveAssetTier({ device: strong, dpr: 1, maxTextureSize: 8192 }).tier, 'lo');
	assert.equal(resolveAssetTier({ device: strong, dpr: 1.5, maxTextureSize: 8192 }).tier, 'lo');
	assert.equal(resolveAssetTier({ device: strong, dpr: 2, maxTextureSize: 2048 }).tier, 'lo');
	// 内存/核数任一达标即可（iPadOS 无 deviceMemory 时看核数）
	assert.equal(resolveAssetTier({ device: { deviceMemory: 2, hardwareConcurrency: 8 }, dpr: 2, maxTextureSize: 8192 }).tier, 'hi');
	assert.equal(resolveAssetTier({ device: { deviceMemory: 8, hardwareConcurrency: 2 }, dpr: 2, maxTextureSize: 8192 }).tier, 'hi');
	assert.equal(resolveAssetTier({ device: { deviceMemory: 4, hardwareConcurrency: 4 }, dpr: 2, maxTextureSize: 4096 }).tier, 'hi', '边界值应通过');
	// 都弱 / 都未知 → lo（保守：宁可 1x）
	assert.equal(resolveAssetTier({ device: { deviceMemory: 2, hardwareConcurrency: 2 }, dpr: 2, maxTextureSize: 8192 }).tier, 'lo');
	assert.equal(resolveAssetTier({ device: {}, dpr: 2, maxTextureSize: 8192 }).tier, 'lo');
	const noGl = resolveAssetTier({ device: strong, dpr: 2 });
	assert.equal(noGl.tier, 'lo');
	assert.match(noGl.reason, /max-texture<4096/);
	const low = resolveAssetTier({ device: {}, dpr: 1 });
	assert.equal(low.tier, 'lo');
	assert.match(low.reason, /dpr<2/);
	assert.match(low.reason, /device-weak/);
	assert.deepEqual(low.signals, { dpr: 1, deviceMemory: null, hardwareConcurrency: null, maxTextureSize: null });
});

test('resolveAssetTier：显式 override（?feiyuTier / localStorage）优先，非法值忽略', () => {
	const strong = { device: { deviceMemory: 8, hardwareConcurrency: 8 }, dpr: 2, maxTextureSize: 8192 };
	const forcedLo = resolveAssetTier({ ...strong, override: 'lo', overrideSource: 'url' });
	assert.equal(forcedLo.tier, 'lo');
	assert.equal(forcedLo.reason, 'override:url');
	assert.deepEqual(forcedLo.override, { tier: 'lo', source: 'url' });
	assert.equal(forcedLo.signals.maxTextureSize, 8192, '覆盖时仍记录设备信号供报告/调试');
	const weak = { device: { deviceMemory: 1, hardwareConcurrency: 1 }, dpr: 1 };
	assert.equal(resolveAssetTier({ ...weak, override: 'hi', overrideSource: 'storage' }).tier, 'hi');
	assert.equal(resolveAssetTier({ ...weak, override: 'HI', overrideSource: 'storage' }).tier, 'hi', '大小写不敏感');
	assert.equal(resolveAssetTier({ ...weak, override: 'auto' }).tier, 'lo', '非法 override 应忽略走 auto');
	assert.equal(resolveAssetTier({ ...weak, override: '  ' }).tier, 'lo');
	assert.equal(resolveAssetTier({ ...weak, override: 1 }).tier, 'lo', '非字符串 override 忽略');
	assert.equal(resolveAssetTier({ ...weak, override: 'hi' }).reason, 'override:explicit');
});

test('assetDirForTier：lo=art/2d5/{shape}，hi=art/2d5/{shape}-hi（默认/空值兜底）', () => {
	assert.equal(assetDirForTier('chibi', 'lo'), 'chibi');
	assert.equal(assetDirForTier('girl', 'hi'), 'girl-hi');
	assert.equal(assetDirForTier('chibi'), 'chibi', '默认 lo');
	assert.equal(assetDirForTier('', 'hi'), 'chibi-hi', '空 shape 兜底 chibi');
	assert.equal(assetDirForTier('girl', 'bogus'), 'girl', '未知 tier 按 lo');
});

/* ---------------- v3.0.1 首屏：tier 渐进升级计划（纯函数） ---------------- */

test('resolveTierPlan：自动 hi → lo 先出图 + 后台升级；显式 override/关闭渐进 → 固定 tier', () => {
	const strong = resolveAssetTier({ device: { deviceMemory: 8, hardwareConcurrency: 8 }, dpr: 2, maxTextureSize: 8192 });
	assert.equal(strong.tier, 'hi');
	assert.deepEqual(resolveTierPlan({ resolution: strong }), {
		targetTier: 'hi', initialTier: 'lo', upgrade: true, reason: 'auto:lo-first',
	});
	// 显式 override（?feiyuTier=lo|hi / localStorage）视为固定最终 tier：不做后台升级
	const forcedHi = resolveAssetTier({ device: {}, dpr: 1, override: 'hi', overrideSource: 'url' });
	assert.deepEqual(resolveTierPlan({ resolution: forcedHi }), {
		targetTier: 'hi', initialTier: 'hi', upgrade: false, reason: 'override:fixed',
	});
	const forcedLo = resolveAssetTier({ device: { deviceMemory: 8, hardwareConcurrency: 8 }, dpr: 2, maxTextureSize: 8192, override: 'lo', overrideSource: 'storage' });
	assert.equal(resolveTierPlan({ resolution: forcedLo }).initialTier, 'lo');
	assert.equal(resolveTierPlan({ resolution: forcedLo }).upgrade, false);
	// 调用方关闭渐进（QA/调试）→ 直接按目标 tier 加载
	const disabled = resolveTierPlan({ resolution: strong, progressive: false });
	assert.deepEqual(disabled, { targetTier: 'hi', initialTier: 'hi', upgrade: false, reason: 'fixed:hi' });
	// 弱机/DPR1 自动 lo：本来就不升级
	const weak = resolveAssetTier({ device: {}, dpr: 1 });
	assert.deepEqual(resolveTierPlan({ resolution: weak }), {
		targetTier: 'lo', initialTier: 'lo', upgrade: false, reason: 'fixed:lo',
	});
	// 容错：空/非法 resolution 按 lo
	assert.equal(resolveTierPlan({}).targetTier, 'lo');
	assert.equal(resolveTierPlan({ resolution: null }).initialTier, 'lo');
});

test('tierUpgradeSettled：终态判定（waitForTierUpgrade 何时 resolve）', () => {
	for (const settled of ['none', 'ready', 'failed', 'skipped', 'cancelled', 'disabled']) {
		assert.equal(tierUpgradeSettled(settled), true, `${settled} 应为终态`);
	}
	for (const pending of ['pending', 'loading', '', null, undefined, 'bogus']) {
		assert.equal(tierUpgradeSettled(pending), false, `${String(pending)} 应为进行中`);
	}
});

test('tierLoadPlan：lo=rig/mesh/atlas1/ready，hi 多一页图集；总阶段数与进度条对齐', () => {
	assert.deepEqual(tierLoadPlan('lo'), { tier: 'lo', pages: 1, stages: ['rig', 'mesh', 'atlas1', 'ready'], total: 4 });
	assert.deepEqual(tierLoadPlan('hi'), { tier: 'hi', pages: 2, stages: ['rig', 'mesh', 'atlas1', 'atlas2', 'ready'], total: 5 });
	assert.equal(tierLoadPlan('bogus').tier, 'lo');
	assert.equal(tierLoadPlan(undefined).pages, 1);
});

test('carryDiyPacks：lo→hi 热升级迁移 DIY pack（drawable/outfits/diyPacks/统计）且不改原场景', () => {
	const drawable = { id: 'diy-x-layer', diy: true, vboBytes: 100, verts: 10, tris: 4, image: { naturalWidth: 10, naturalHeight: 20 } };
	const entry = { packId: 'diy-x', drawableIds: ['diy-x-layer'], drawables: [drawable], outfitIds: ['diy-x'], textures: ['diy-x.png'] };
	const from = {
		drawables: [drawable], drawableById: { 'diy-x-layer': drawable },
		outfits: { 'diy-x': { topBody: ['diy-x-layer'] } },
		diyPacks: new Map([['diy-x', entry]]),
		stats: { texBytes: 800, vboBytes: 100, verts: 10, tris: 4 },
	};
	const to = {
		drawables: [], drawableById: {}, outfits: { maid: { topBody: ['maid-top'] } },
		diyPacks: new Map(), stats: { texBytes: 0, vboBytes: 0, verts: 0, tris: 0 },
	};
	const result = carryDiyPacks(from, to);
	assert.deepEqual(result.carried, ['diy-x']);
	assert.equal(to.drawables.length, 1);
	assert.equal(to.drawableById['diy-x-layer'], drawable);
	assert.deepEqual(to.outfits['diy-x'], { topBody: ['diy-x-layer'] });
	assert.equal(to.diyPacks.get('diy-x'), entry);
	assert.equal(to.stats.texBytes, 800, '纹理字节按图像尺寸计入新场景');
	assert.equal(to.stats.vboBytes, 100);
	assert.equal(from.drawables.length, 1, '不修改原场景（旧场景由 runtime keepDiy 释放跳过）');
	// 幂等：重复迁移不重复挂载
	const again = carryDiyPacks(from, to);
	assert.deepEqual(again.carried, []);
	assert.deepEqual(again.skipped, ['diy-x']);
	assert.equal(to.drawables.length, 1);
	// 空场景容错
	assert.deepEqual(carryDiyPacks(null, to), { carried: [], packIds: [], skipped: [] });
	assert.deepEqual(carryDiyPacks(from, null), { carried: [], packIds: [], skipped: [] });
});

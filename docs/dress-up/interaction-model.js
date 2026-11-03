/**
 * M5 互动 / 动作库 —— 纯逻辑模块（无 DOM / 无 WebGL，可在 node 里单测）。
 *
 * 职责：
 * - 点击分区（头部 / 身体）：点击/拖头区分互动类型；
 * - 动作曲线：把「点头 / 歪头 / 摸头反馈 / 喂食 / 打招呼」定义成参数总线上的
 *   时间函数，全部复用 M3 参数总线（headX/headY/headZ/…），不新增骨骼；
 * - 台词选择：按分组从 manifest.bubbleSets 选句（无重复最近 2 条、分组回退）；
 * - 心情 → 表情/待机策略映射（DOM 与 2.5D 共用）。
 *
 * 设计契约：`.scratch/m5/DESIGN.md` §4/§5；本模块不读 localStorage、不发请求、不改 runtime。
 */

import { clampParams } from './runtime-2d5-core.js';

/** 头部点击区：图框内归一化坐标（0..1）——y<0.42 且 |x-0.5|<0.38。 */
export const HEAD_ZONE = { yMax: 0.42, halfWidth: 0.38 };

/**
 * 指针位置 → 互动分区。
 * @param {number} nx 归一化 x（0..1，相对角色框）
 * @param {number} ny 归一化 y（0..1）
 * @returns {'head'|'body'|'outside'}
 */
export function hitZone(nx, ny) {
	if (!Number.isFinite(nx) || !Number.isFinite(ny)) return 'outside';
	if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return 'outside';
	return ny < HEAD_ZONE.yMax && Math.abs(nx - 0.5) < HEAD_ZONE.halfWidth ? 'head' : 'body';
}

/**
 * 动作定义（时长 + 参数曲线）。curve(t) 返回参数总线 partial（t∈[0,1]；
 * 端点 t=0/1 的偏移必须为 0，保证动作开始/结束无跳变）。
 * face/runtime 字段是给调用方的语义提示（DOM 补丁 / 2.5D trigger*），本模块不执行。
 * @type {Record<string, {durationMs: number, curve: (t: number) => Record<string, number>, face?: {smileMs?: number}, runtime?: string}>}
 */
export const ACTION_SPECS = {
	nod: {
		durationMs: 400,
		curve: (t) => ({ headX: 8 * Math.sin(Math.PI * t) }),
	},
	tilt: {
		durationMs: 600,
		curve: (t) => ({ headZ: 12 * Math.sin(Math.PI * t) }),
	},
	pat: {
		durationMs: 420,
		curve: (t) => ({ headZ: -7 * Math.sin(Math.PI * t) }),
		face: { smileMs: 800 },
		runtime: 'tap',
	},
	feed: {
		durationMs: 1400,
		// 两次轻点头；口型由 triggerTalk 负责（runtime 提示）
		curve: (t) => ({ headX: 5 * Math.sin(2 * Math.PI * t) }),
		face: {},
		runtime: 'talk',
	},
	greet: {
		durationMs: 900,
		curve: (t) => ({
			headX: 7 * Math.sin(Math.PI * t),
			headZ: 4 * Math.sin(Math.PI * t),
		}),
		face: { smileMs: 1200 },
		runtime: 'smile',
	},
	idle: { durationMs: 0, curve: () => ({}) },
};

/**
 * 按已播放毫秒数采样动作参数（与上一帧参数合并后钳制，避免跨动作跳变）。
 * @param {string} kind ACTION_SPECS key
 * @param {number} elapsedMs 已播放毫秒
 * @param {Record<string, number>} [previous] 当前参数（跨动作插值基底）
 * @returns {{done: boolean, t: number, params: Record<string, number>}}
 */
export function actionParams(kind, elapsedMs, previous) {
	const spec = ACTION_SPECS[kind];
	if (!spec || !(spec.durationMs > 0)) {
		return { done: true, t: 1, params: clampParams(previous, {}) };
	}
	const duration = spec.durationMs;
	const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	const t = Math.min(1, elapsed / duration);
	const raw = spec.curve(t);
	/** 曲线端点浮点误差（sin(π)≈1e-16）归零，保证动作开始/结束参数严格回位。 */
	const EPS = 1e-6;
	const cleaned = {};
	for (const [key, value] of Object.entries(raw)) {
		cleaned[key] = Number.isFinite(value) && Math.abs(value) >= EPS ? value : 0;
	}
	return { done: elapsed >= duration, t, params: clampParams(previous, cleaned) };
}

/** 台词分组回退顺序：优先精确分组，其次心情/兜底。 */
export const LINE_FALLBACK = {
	pat: ['pat', 'idle'],
	feed: ['feed', 'idle'],
	greet: ['greet', 'idle'],
	idle: ['idle'],
	hungry: ['hungry', 'idle'],
	full: ['full', 'feed', 'idle'],
	levelUp: ['levelUp', 'greet', 'idle'],
};

/**
 * 选一句台词：优先未在 recent 中出现过的句子；空分组按 LINE_FALLBACK 回退。
 * @param {Record<string, string[]>} bubbleSets manifest.bubbleSets
 * @param {string} group 分组名（pat/feed/greet/idle/hungry/full/levelUp）
 * @param {{rand?: () => number, recent?: string[], fallback?: string}} [options]
 * @returns {string}
 */
export function pickLine(bubbleSets, group, options = {}) {
	const rand = typeof options.rand === 'function' ? options.rand : Math.random;
	const recent = Array.isArray(options.recent) ? options.recent : [];
	const sets = bubbleSets && typeof bubbleSets === 'object' ? bubbleSets : {};
	const chain = LINE_FALLBACK[group] || [group, 'idle'];
	for (const name of chain) {
		const raw = sets[name];
		const lines = Array.isArray(raw) ? raw.filter((line) => typeof line === 'string' && line.trim()) : [];
		if (lines.length === 0) continue;
		const fresh = lines.filter((line) => !recent.includes(line));
		const pool = fresh.length > 0 ? fresh : lines;
		const index = Math.floor(rand() * pool.length);
		return pool[Math.min(pool.length - 1, Math.max(0, index))];
	}
	return options.fallback ?? '嗯？';
}

/**
 * 喂食两句台词（开饭 → 好吃），保证两句不同；无第二句时允许重复同一句。
 * @param {Record<string, string[]>} bubbleSets
 * @param {{rand?: () => number, recent?: string[]}} [options]
 * @returns {[string, string]}
 */
export function feedLines(bubbleSets, options = {}) {
	const first = pickLine(bubbleSets, 'feed', options);
	const second = pickLine(bubbleSets, 'feed', {
		...options,
		recent: [...(Array.isArray(options.recent) ? options.recent : []), first],
	});
	return [first, second];
}

/**
 * 心情 → 表情/待机策略。
 * - smileEvery：随机笑眼间隔区间（ms，null=不主动笑）；
 * - headDown：DOM/2.5D 额外低头角度（度）；
 * - mouthMidPulse：是否偶尔显示小口型（DOM 用 mouthMid 补丁，2.5D 用 mouthOpen 参数脉冲）；
 * - idleGroup：待机台词优先分组。
 * @type {Record<string, {smileEvery: [number, number] | null, headDown: number, mouthMidPulse: boolean, idleGroup: string}>}
 */
export const MOOD_FACE_PLAN = {
	starving: { smileEvery: null, headDown: 2, mouthMidPulse: false, idleGroup: 'hungry' },
	hungry: { smileEvery: null, headDown: 1.5, mouthMidPulse: false, idleGroup: 'hungry' },
	fine: { smileEvery: [9000, 16000], headDown: 0, mouthMidPulse: false, idleGroup: 'idle' },
	happy: { smileEvery: [6000, 10000], headDown: 0, mouthMidPulse: false, idleGroup: 'idle' },
	stuffed: { smileEvery: [8000, 14000], headDown: 0, mouthMidPulse: true, idleGroup: 'full' },
};

/**
 * @param {string} moodKey MOOD_LEVELS key
 * @returns {{smileEvery: [number, number] | null, headDown: number, mouthMidPulse: boolean, idleGroup: string}}
 */
export function moodFacePlan(moodKey) {
	return MOOD_FACE_PLAN[moodKey] || MOOD_FACE_PLAN.fine;
}

/**
 * 把一次指针手势归类为互动：按下在头部且拖动 ≥ 阈值 → 摸头；头部轻点 → 摸头；
 * 身体点击 → 说话（不做经济写入）。
 * @param {{zone: 'head'|'body'|'outside', distancePx: number, thresholdPx?: number}} gesture
 * @returns {'pat'|'talk'|'none'}
 */
export function classifyGesture(gesture) {
	const threshold = Number.isFinite(gesture.thresholdPx) ? gesture.thresholdPx : 24;
	if (gesture.zone === 'head') return 'pat';
	if (gesture.zone === 'body') return 'talk';
	return 'none';
}

/** 动作别名（页面语义 → 曲线）。挥手按 Lead 决策 = greet 替代，不新增手臂参数。 */
export const ACTION_ALIASES = { wave: 'greet', hello: 'greet', headpat: 'pat', feed: 'feed' };

/**
 * @param {string} action
 * @returns {string}
 */
export function resolveAction(action) {
	if (ACTION_SPECS[action]) return action;
	const alias = ACTION_ALIASES[action];
	return alias && ACTION_SPECS[alias] ? alias : 'idle';
}

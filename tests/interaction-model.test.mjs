/** M5 draft 单测（离线验证纯逻辑；实现期并入仓库 tests/interaction-model.test.mjs）。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ACTION_ALIASES,
	ACTION_PARAM_LIMITS,
	ACTION_SPECS,
	DEFAULT_ACTION_PARAMS,
	HEAD_ZONE,
	MOOD_FACE_PLAN,
	actionParams,
	classifyGesture,
	feedLines,
	hitZone,
	moodFacePlan,
	pickLine,
	resolveAction,
} from '../docs/dress-up/interaction-model.js';
import { DEFAULT_2D5_PARAMS, PARAM_LIMITS } from '../docs/dress-up/runtime-2d5-core.js';

test('参数总线默认值/上限与 runtime-2d5-core 同步（本地副本防漂移）', () => {
	assert.deepEqual(DEFAULT_ACTION_PARAMS, DEFAULT_2D5_PARAMS, '默认参数与 core 不一致');
	assert.deepEqual(ACTION_PARAM_LIMITS, PARAM_LIMITS, '参数上限与 core 不一致');
});

const BUBBLES = {
	pat: ['摸头呀。', '头发要乱啦。', '谢谢你陪我。'],
	feed: ['开饭啦。', '啊呜好吃。', '给你留一半。'],
	greet: ['早上好。', '你回来啦。'],
	idle: ['窗外的光刚刚好。'],
	hungry: ['肚子空空的。'],
	full: ['有点吃撑了。'],
	levelUp: ['我们更熟一点了。'],
};

test('hitZone：头部/身体/框外', () => {
	assert.equal(hitZone(0.5, 0.2), 'head');
	assert.equal(hitZone(0.5, 0.6), 'body');
	assert.equal(hitZone(0.05, 0.2), 'body'); // 偏左超出头区
	assert.equal(hitZone(-0.1, 0.5), 'outside');
	assert.equal(hitZone(NaN, 0.5), 'outside');
	assert.ok(HEAD_ZONE.yMax > 0.2 && HEAD_ZONE.yMax < 0.6);
});

test('actionParams：端点无偏移、时段有动画、未知动作安全', () => {
	for (const kind of Object.keys(ACTION_SPECS)) {
		const start = actionParams(kind, 0);
		const peak = actionParams(kind, ACTION_SPECS[kind].durationMs / 2);
		const end = actionParams(kind, ACTION_SPECS[kind].durationMs);
		assert.equal(start.done, kind === 'idle' ? true : false);
		assert.equal(end.done, true);
		const touched = Object.keys(ACTION_SPECS[kind].curve(0));
		for (const key of Object.keys(PARAM_LIMITS)) {
			assert.ok(Number.isFinite(start.params[key]));
			assert.ok(Number.isFinite(peak.params[key]));
			if (!touched.includes(key)) {
				assert.equal(start.params[key], end.params[key], `${kind} 未动参数 ${key} 起终点一致`);
				continue;
			}
			assert.ok(Math.abs(start.params[key]) < 1e-9, `${kind} 起点 ${key} 应回 0`);
			assert.ok(Math.abs(end.params[key]) < 1e-9, `${kind} 终点 ${key} 应回 0`);
		}
	}
	const mid = actionParams('nod', 200);
	assert.ok(mid.params.headX > 0 && mid.params.headX <= PARAM_LIMITS.headX[1]);
	const unknown = actionParams('nope', 100);
	assert.equal(unknown.done, true);
});

test('actionParams：与上一帧参数合并且钳制', () => {
	const merged = actionParams('nod', 0, { headZ: 10, breath: 0.3 });
	assert.equal(merged.params.headZ, 10, '未动参数保留');
	assert.equal(merged.params.breath, 0.3);
	const clamped = actionParams('tilt', 999, { headZ: 99 });
	assert.ok(clamped.params.headZ <= PARAM_LIMITS.headZ[1]);
});

test('pickLine：随机可注入、不重复最近句、空分组回退', () => {
	const line = pickLine(BUBBLES, 'pat', { rand: () => 0 });
	assert.equal(line, '摸头呀。');
	const noRepeat = pickLine(BUBBLES, 'pat', { rand: () => 0, recent: ['摸头呀。'] });
	assert.notEqual(noRepeat, '摸头呀。');
	const fallback = pickLine(BUBBLES, 'feed', { rand: () => 0.99, recent: BUBBLES.feed });
	assert.ok(BUBBLES.feed.includes(fallback));
	const empty = pickLine({}, 'pat', { fallback: '兜底' });
	assert.equal(empty, '兜底');
	const chain = pickLine({ pat: [], idle: ['嗯。'] }, 'pat', { rand: () => 0 });
	assert.equal(chain, '嗯。', 'pat 空 → idle 回退');
});

test('feedLines：两条不同（不足时允许重复）', () => {
	const [a, b] = feedLines(BUBBLES, { rand: (() => { let i = 0; return () => (i++ % 2) * 0.4; })() });
	assert.notEqual(a, b);
	const single = feedLines({ feed: ['只有一句。'] }, { rand: () => 0 });
	assert.deepEqual(single, ['只有一句。', '只有一句。']);
});

test('moodFacePlan：五档全覆盖 + 未知回退', () => {
	for (const key of ['starving', 'hungry', 'fine', 'happy', 'stuffed']) {
		const plan = moodFacePlan(key);
		assert.ok(plan && typeof plan.idleGroup === 'string');
		assert.ok(Number.isFinite(plan.headDown));
		assert.equal(typeof plan.mouthMidPulse, 'boolean');
	}
	assert.deepEqual(moodFacePlan('nope'), MOOD_FACE_PLAN.fine);
	assert.equal(moodFacePlan('hungry').idleGroup, 'hungry');
});

test('手势归类 + 动作别名（挥手→greet，不新增手臂参数）', () => {
	assert.equal(classifyGesture({ zone: 'head', distancePx: 0 }), 'pat');
	assert.equal(classifyGesture({ zone: 'body', distancePx: 60 }), 'talk');
	assert.equal(classifyGesture({ zone: 'outside', distancePx: 0 }), 'none');
	assert.equal(resolveAction('wave'), 'greet');
	assert.equal(resolveAction('nod'), 'nod');
	assert.equal(resolveAction('unknown'), 'idle');
	assert.equal(ACTION_ALIASES.wave, 'greet');
});

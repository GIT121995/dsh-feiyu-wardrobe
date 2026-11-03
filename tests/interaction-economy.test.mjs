/** M5 互动经济：冷却/日限/余额/stuffed/full 拒绝零变更；mood/intimacy 加项与上限。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import {
	INTERACTION_RULES,
	applyFeed,
	applyGreet,
	applyMeal,
	applyPat,
	canInteract,
	interactionSummary,
	intimacyOf,
	moodOf,
	todayInteractions,
} from '../lib/economy.js';
import { createState } from '../lib/state.js';

const NOW = Date.parse('2026-11-03T02:00:00Z');
const config = validateConfig({ statePath: '/tmp/feiyu-m5-econ.json' });
const fresh = (coins = 100) => {
	const state = createState(config, NOW - 10 * 86_400_000);
	state.coins = coins;
	return state;
};

test('pat：冷却 20s + 日限 12 + 零鱼粮；被拒绝时零变更', () => {
	const state = fresh();
	const first = canInteract(state, 'pat', NOW, config);
	assert.equal(first.ok, true);
	applyPat(state, NOW, config);
	const before = JSON.stringify(state.interactions);
	assert.deepEqual(canInteract(state, 'pat', NOW + 1000, config), { ok: false, reason: 'cooldown', retryInMs: 19000 });
	assert.equal(JSON.stringify(state.interactions), before, 'cooldown 检查不应改状态');
	for (let i = 1; i < INTERACTION_RULES.pat.dailyMax; i++) applyPat(state, NOW + i * 21_000, config);
	const capped = canInteract(state, 'pat', NOW + 12 * 21_000, config);
	assert.equal(capped.ok, false);
	assert.equal(capped.reason, 'daily-cap');
	assert.equal(state.coins, 100, 'pat 不消耗鱼粮');
});

test('feed：扣鱼粮、coinsSpent 记账、余额不足/冷却零变更、永不负余额', () => {
	const state = fresh(10);
	assert.equal(canInteract(state, 'feed', NOW, config, 'big').ok, true);
	applyFeed(state, 'big', NOW, config);
	assert.equal(state.coins, 2);
	assert.equal(state.totals.coinsSpent, 8);
	assert.equal(state.interactions.lifetime.coinsSpent, 8);
	assert.equal(todayInteractions(state, NOW, config).coinsSpent, 8);
	const before = JSON.stringify(state);
	const noCoins = canInteract(state, 'feed', NOW + 60_000, config, 'big');
	assert.equal(noCoins.ok, false);
	assert.equal(noCoins.reason, 'no-coins');
	assert.equal(JSON.stringify(state), before, '余额不足检查不应改状态');
	// small 仍需 3 鱼粮 → 2 不够
	assert.equal(canInteract(state, 'feed', NOW + 60_000, config, 'small').ok, false);
});

test('feed：45s 冷却、日限 3、吃撑(full) 拒绝；失败零变更', () => {
	const state = fresh(1000);
	state.interactions.daily = {}; // 干净起点
	// 冷却：先真喂一次，再在 1s 后检查（失败零变更）
	applyMeal(state, { costCNY: 0.1 }, NOW, config);
	assert.equal(canInteract(state, 'feed', NOW, config, 'small').ok, true);
	applyFeed(state, 'small', NOW, config);
	const cooldownBefore = JSON.stringify(state);
	assert.equal(canInteract(state, 'feed', NOW + 1000, config, 'small').reason, 'cooldown');
	assert.equal(JSON.stringify(state), cooldownBefore);
	let t = NOW + 60_000;
	for (let i = 0; i < INTERACTION_RULES.feed.dailyMax - 1; i++) {
		assert.equal(canInteract(state, 'feed', t, config, 'small').ok, true, `第${i + 1}次应可用`);
		applyFeed(state, 'small', t, config);
		t += INTERACTION_RULES.feed.cooldownMs + 1;
	}
	const capped = canInteract(state, 'feed', t + 60_000, config, 'small');
	assert.equal(capped.ok, false);
	assert.equal(capped.reason, 'daily-cap');
	assert.equal(state.coins, 1000 + 10 - 3 * INTERACTION_RULES.feed.dailyMax); // +10=meal 折鱼粮，-9=3 次小份
});

test('feed：mood >= 95（stuffed）时拒绝 reason=full', () => {
	const state = fresh(1000);
	state.lastMealAt = NOW;
	state.streak = { lastDay: '2026-11-03', days: 6 };
	state.daily = { '2026-11-03': { costCNY: 0, meals: 4, interactions: 0 } };
	state.interactions.daily = { '2026-11-03': { pats: 6, feeds: 0, greets: 1, coinsSpent: 0 } };
	assert.ok(moodOf(state, NOW, config).score >= 95, '前置：应处于吃撑档');
	assert.equal(canInteract(state, 'feed', NOW, config, 'small').reason, 'full');
});

test('greet：1 次/天，跨天用 dayKey 判定', () => {
	const state = fresh();
	assert.equal(canInteract(state, 'greet', NOW, config).ok, true);
	applyGreet(state, NOW, config);
	assert.equal(canInteract(state, 'greet', NOW + 3_600_000, config).reason, 'daily-cap');
	const nextDay = NOW + 24 * 3_600_000;
	assert.equal(canInteract(state, 'greet', nextDay, config).ok, true);
	assert.equal(applyGreet(state, nextDay, config).ok, true);
	assert.equal(state.interactions.lifetime.greets, 2);
});

test('moodOf：互动加项封顶、总 0..100；无互动时与旧公式一致', () => {
	const legacy = fresh();
	applyMeal(legacy, { costCNY: 0.2 }, NOW, config);
	const legacyScore = moodOf(legacy, NOW, config).score;
	const state = fresh();
	applyMeal(state, { costCNY: 0.2 }, NOW, config);
	const same = moodOf(state, NOW, config).score;
	assert.equal(same, legacyScore, '无互动项时与旧口径一致');
	state.interactions.daily = { '2026-11-03': { pats: 99, feeds: 99, greets: 9, coinsSpent: 0 } };
	state.lastMealAt = NOW;
	const boosted = moodOf(state, NOW, config);
	assert.ok(boosted.score >= legacyScore);
	assert.ok(boosted.score <= 100);
	// pat 项封顶：pats*2 但封顶 12；feeds 封顶 18；greet 4
	const cappedState = fresh();
	cappedState.lastMealAt = NOW;
	cappedState.interactions.daily = { '2026-11-03': { pats: 100, feeds: 100, greets: 1, coinsSpent: 0 } };
	const baseState = fresh();
	baseState.lastMealAt = NOW;
	assert.equal(
		moodOf(cappedState, NOW, config).score - moodOf(baseState, NOW, config).score,
		12 + 18 + 4,
		'互动心情加项应封顶 12+18+4',
	);
});

test('intimacyOf：互动终身贡献封顶 10；无互动时与旧口径一致', () => {
	const legacy = fresh();
	const base = intimacyOf(legacy, NOW, config).score;
	const state = fresh();
	assert.equal(intimacyOf(state, NOW, config).score, base);
	state.interactions.lifetime = { pats: 1000, feeds: 1000, greets: 1000, coinsSpent: 0 };
	const boosted = intimacyOf(state, NOW, config);
	assert.ok(boosted.score >= base);
	assert.ok(boosted.score <= 100);
	assert.equal(
		boosted.score - base,
		Math.min(10, Math.round(1000 * 0.2 + 1000 * 0.5 + 1000 * 0.5)),
		'互动贡献封顶 10（raw 钳制取整后差异）',
	);
});

test('interactionSummary：形状/冷却/原因/成本/日限字段齐全且不含台词文本', () => {
	const state = fresh(4);
	applyPat(state, NOW, config);
	const summary = interactionSummary(state, NOW + 1000, config);
	assert.equal(summary.enabled, true);
	assert.ok(Number.isFinite(summary.coins));
	assert.ok(summary.mood && typeof summary.mood.label === 'string');
	assert.ok(summary.intimacy && typeof summary.intimacy.title === 'string');
	assert.equal(summary.today.pats, 1);
	assert.deepEqual(summary.costs, { small: 3, big: 8 });
	assert.deepEqual(summary.limits, { patDailyMax: 12, feedDailyMax: 3 });
	assert.equal(summary.allowed.pat, false);
	assert.ok(summary.retryIn.pat > 0);
	assert.equal(summary.allowed.feedBig, false);
	assert.equal(summary.allowed.feedSmall, true); // 4 鱼粮 ≥ small 3；feed 无冷却 → 可用
});

test('disabled：config.dressUp.interaction.enabled=false 时 canInteract 返回 disabled', () => {
	const cfg = validateConfig({ statePath: '/tmp/feiyu-m5-econ2.json', dressUp: { interaction: { enabled: false } } });
	const state = createState(cfg, NOW);
	assert.deepEqual(canInteract(state, 'pat', NOW, cfg), { ok: false, reason: 'disabled' });
});

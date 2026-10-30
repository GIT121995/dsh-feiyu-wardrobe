import assert from 'node:assert/strict';
import test from 'node:test';

import {
	INTIMACY_LEVELS,
	MOOD_LEVELS,
	applyInteraction,
	applyMeal,
	coinsForCost,
	intimacyOf,
	moodOf,
	summaryOf,
	todayStats,
} from '../lib/economy.js';
import { validateConfig } from '../lib/config.js';
import { createState, daysAlive, normalizeState, pruneDaily, saveState, loadState, touchSession, MAX_SESSIONS } from '../lib/state.js';

const NOW = Date.parse('2026-10-30T02:30:00Z');
const config = validateConfig({ statePath: '/tmp/feiyu-test-state.json' });

function freshState(now = NOW) {
	return createState(config, now - 10 * 86_400_000);
}

test('coinsForCost converts CNY at the configured rate', () => {
	assert.equal(coinsForCost(1, 100), 100);
	assert.equal(coinsForCost(0.0123, 100), 1.23);
	assert.equal(coinsForCost(-1, 100), 0);
});

test('a new fish has the birth gift and the starter item', () => {
	const state = createState(config, NOW);
	assert.equal(state.coins, config.birthGiftCoins);
	assert.deepEqual(state.owned, ['hat-leaf']);
	assert.equal(daysAlive(state, NOW), 1);
});

test('meals convert token cost into coins and advance the daily ledger', () => {
	const state = freshState();
	const result = applyMeal(state, { costCNY: 0.5, usage: { cacheMissInput: 1000, output: 200 } }, NOW, config);
	assert.equal(result.coins, 50);
	assert.equal(state.coins, config.birthGiftCoins + 50);
	assert.equal(state.totals.meals, 1);
	assert.equal(state.totals.tokens.input, 1000);
	assert.equal(state.totals.tokens.output, 200);
	const today = todayStats(state, NOW, config);
	assert.equal(today.meals, 1);
	assert.equal(today.costCNY, 0.5);
});

test('streak grows on consecutive days and resets after a gap', () => {
	const state = freshState();
	applyMeal(state, { costCNY: 0.1 }, NOW - 2 * 86_400_000, config);
	assert.equal(state.streak.days, 1);
	applyMeal(state, { costCNY: 0.1 }, NOW - 86_400_000, config);
	assert.equal(state.streak.days, 2);
	applyMeal(state, { costCNY: 0.1 }, NOW, config);
	assert.equal(state.streak.days, 3);
	applyMeal(state, { costCNY: 0.1 }, NOW, config);
	assert.equal(state.streak.days, 3, 'same day does not extend the streak');
	applyMeal(state, { costCNY: 0.1 }, NOW + 2 * 86_400_000, config);
	assert.equal(state.streak.days, 1, 'a gap resets the streak');
});

test('interactions are counted separately from meals', () => {
	const state = freshState();
	applyInteraction(state, NOW, config);
	applyInteraction(state, NOW, config);
	assert.equal(state.totals.interactions, 2);
	assert.equal(state.totals.meals, 0);
	assert.equal(todayStats(state, NOW, config).interactions, 2);
});

test('intimacy combines talk, meals and age into tiers', () => {
	const state = freshState();
	state.totals.interactions = 12;
	state.totals.meals = 30;
	const intimacy = intimacyOf(state, NOW, config);
	assert.ok(intimacy.score >= 35 && intimacy.score <= 100);
	assert.ok(INTIMACY_LEVELS.some((level) => level.title === intimacy.title));
	assert.ok(intimacy.nextAt === null || intimacy.nextAt > intimacy.score);
});

test('mood rewards recent meals and punishes long silence', () => {
	const state = freshState();
	state.lastMealAt = null;
	state.streak = { lastDay: null, days: 0 };
	const starving = moodOf(state, NOW, config);
	assert.equal(starving.key, 'starving');

	applyMeal(state, { costCNY: 0.4 }, NOW - 20 * 60_000, config);
	applyMeal(state, { costCNY: 0.4 }, NOW - 10 * 60_000, config);
	applyInteraction(state, NOW - 5 * 60_000, config);
	const fed = moodOf(state, NOW, config);
	assert.ok(['fine', 'happy', 'stuffed'].includes(fed.key), `unexpected mood ${fed.key}`);
	assert.ok(fed.score > starving.score);
	assert.ok(MOOD_LEVELS.some((level) => level.key === fed.key));
});

test('summaryOf exposes card-ready numbers', () => {
	const state = freshState();
	applyMeal(state, { costCNY: 0.5, usage: { cacheMissInput: 1000 } }, NOW, config);
	const summary = summaryOf(state, NOW, config);
	assert.equal(summary.fishName, config.fishName);
	assert.equal(summary.meals, 1);
	assert.equal(summary.costCNY, 0.5);
	assert.ok(summary.daysAlive >= 10);
	assert.ok(summary.intimacy.score >= 0);
	assert.ok(summary.mood.label.length > 0);
});

test('normalizeState repairs junk and keeps valid pieces', () => {
	const state = normalizeState(
		{
			fishName: ' 修理鱼 ',
			coins: -3,
			owned: ['hat-leaf', 'hat-straw', 42],
			equipped: { hat: 'hat-crown', face: 'hat-straw' },
			daily: { '2026-10-30': { costCNY: 1.2, meals: 3, interactions: 1 }, bad: 1 },
			streak: { lastDay: '2026-10-30', days: 4 },
		},
		config,
		NOW,
	);
	assert.equal(state.fishName, '修理鱼');
	assert.equal(state.coins, config.birthGiftCoins, 'negative coins fall back to the gift');
	assert.ok(state.owned.includes('hat-straw'));
	assert.deepEqual(state.equipped, {}, 'equipping an unowned item is dropped');
	assert.equal(state.daily['2026-10-30'].meals, 3);
	assert.equal(state.streak.days, 4);
});

test('loadState creates a fresh fish and saveState round-trips', () => {
	const dir = `/tmp/feiyu-state-${process.pid}-${Date.now()}`;
	const local = validateConfig({ statePath: `${dir}/state.json` });
	const first = loadState(local.statePath, local, NOW);
	assert.equal(first.isNew, true);
	first.state.coins = 42;
	saveState(local.statePath, first.state, NOW);
	const second = loadState(local.statePath, local, NOW);
	assert.equal(second.isNew, false);
	assert.equal(second.state.coins, 42);
});

test('pruneDaily keeps only the retention window', () => {
	const state = freshState();
	for (let offset = 0; offset < 30; offset += 1) {
		state.daily[`2026-10-${String(1 + offset).padStart(2, '0')}`] = { costCNY: 0, meals: 0, interactions: 0 };
	}
	const local = validateConfig({ statePath: '/tmp/x.json', dailyRetentionDays: 7 });
	const removed = pruneDaily(state, local, NOW);
	assert.equal(removed, 23);
	assert.equal(Object.keys(state.daily).length, 7);
});

test('touchSession is bounded and deduplicated', () => {
	const state = freshState();
	assert.equal(touchSession(state, 'a'), true);
	assert.equal(touchSession(state, 'a'), false);
	for (let index = 0; index < MAX_SESSIONS + 20; index += 1) touchSession(state, `s-${index}`);
	assert.equal(state.sessions.length, MAX_SESSIONS);
});

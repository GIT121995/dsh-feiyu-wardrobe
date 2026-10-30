/**
 * Fish economy: token spend becomes fish-food coins, meals and chats become
 * intimacy, and recent activity decides the mood shown on the card.
 *
 * All functions are deterministic given `now`, which keeps the tests honest.
 * @module dsh-feiyu-wardrobe/economy
 */

import { dayKey, clamp, round } from './util.js';
import { daysAlive } from './state.js';

/**
 * Intimacy tiers, lowest first.
 * @type {Array<{ min: number, title: string, emoji: string }>}
 */
export const INTIMACY_LEVELS = [
	{ min: 0, title: '陌生鱼', emoji: '🐟' },
	{ min: 15, title: '点头之交', emoji: '🐳' },
	{ min: 35, title: '饭搭子', emoji: '🍚' },
	{ min: 55, title: '老饭友', emoji: '🍱' },
	{ min: 75, title: '家人', emoji: '🏠' },
	{ min: 95, title: '过命交情', emoji: '💙' },
];

/**
 * Mood tiers, lowest first. `face` selects the expression drawn by render.js.
 * @type {Array<{ max: number, key: string, label: string, emoji: string, face: string }>}
 */
export const MOOD_LEVELS = [
	{ max: 15, key: 'starving', label: '饿晕了', emoji: '🫠', face: 'hungry' },
	{ max: 45, key: 'hungry', label: '有点饿', emoji: '🍚', face: 'calm' },
	{ max: 72, key: 'fine', label: '悠哉', emoji: '🐳', face: 'calm' },
	{ max: 90, key: 'happy', label: '满足', emoji: '😊', face: 'happy' },
	{ max: 100, key: 'stuffed', label: '撑到翻肚', emoji: '🐡', face: 'stuffed' },
];

/**
 * Convert token spend into fish-food coins.
 * @param {number} costCNY
 * @param {number} coinPerCNY
 * @returns {number}
 */
export function coinsForCost(costCNY, coinPerCNY) {
	const cost = Math.max(0, Number(costCNY) || 0);
	const rate = Math.max(0, Number(coinPerCNY) || 0);
	return round(cost * rate, 4);
}

/**
 * Advance the daily-streak counter when the fish is active on a new day.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {{ days: number, extended: boolean }}
 */
export function bumpStreak(state, now, config) {
	const today = dayKey(now, config.timezoneOffsetMinutes);
	const last = state.streak.lastDay;
	if (last === today) return { days: state.streak.days, extended: false };
	let days = 1;
	if (last) {
		const [ly, lm, ld] = last.split('-').map(Number);
		const [ty, tm, td] = today.split('-').map(Number);
		const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(ly, lm - 1, ld)) / 86_400_000);
		if (diff === 1) days = state.streak.days + 1;
	}
	state.streak = { lastDay: today, days };
	return { days, extended: days > 1 };
}

/**
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {import('./state.js').DayStats}
 */
export function todayStats(state, now, config) {
	const key = dayKey(now, config.timezoneOffsetMinutes);
	const row = state.daily[key];
	return row ? { ...row } : { costCNY: 0, meals: 0, interactions: 0 };
}

/**
 * Record one priced model call: the fish eats.
 * @param {import('./state.js').FishState} state
 * @param {{ costCNY: number, usage?: { cacheHitInput?: number, cacheMissInput?: number, cacheWriteInput?: number, output?: number, total?: number } }} priced
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {{ coins: number, costCNY: number }}
 */
export function applyMeal(state, priced, now, config) {
	const key = dayKey(now, config.timezoneOffsetMinutes);
	const today = (state.daily[key] ??= { costCNY: 0, meals: 0, interactions: 0 });
	const cost = Math.max(0, Number(priced?.costCNY) || 0);
	const coins = coinsForCost(cost, config.coinPerCNY);
	const usage = priced?.usage ?? {};
	const tokens = state.totals.tokens;
	tokens.input += Math.max(0, Math.round(Number(usage.cacheMissInput) || 0));
	tokens.cacheRead += Math.max(0, Math.round(Number(usage.cacheHitInput) || 0));
	tokens.cacheWrite += Math.max(0, Math.round(Number(usage.cacheWriteInput) || 0));
	tokens.output += Math.max(0, Math.round(Number(usage.output) || 0));
	tokens.total += Math.max(
		0,
		Math.round(Number(usage.total) || (Number(usage.cacheMissInput) || 0) + (Number(usage.cacheHitInput) || 0) + (Number(usage.cacheWriteInput) || 0) + (Number(usage.output) || 0)),
	);
	state.totals.costCNY = round(state.totals.costCNY + cost, 6);
	state.totals.coinsEarned = round(state.totals.coinsEarned + coins, 4);
	state.totals.meals += 1;
	state.coins = round(state.coins + coins, 4);
	today.costCNY = round(today.costCNY + cost, 6);
	today.meals += 1;
	state.lastMealAt = now;
	state.lastActiveAt = now;
	bumpStreak(state, now, config);
	return { coins, costCNY: cost };
}

/**
 * Record one human message: the fish gets talked to.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {{ interactions: number }}
 */
export function applyInteraction(state, now, config) {
	const key = dayKey(now, config.timezoneOffsetMinutes);
	const today = (state.daily[key] ??= { costCNY: 0, meals: 0, interactions: 0 });
	state.totals.interactions += 1;
	today.interactions += 1;
	state.lastActiveAt = now;
	bumpStreak(state, now, config);
	return { interactions: state.totals.interactions };
}

/**
 * Intimacy score (0–100) and the matching tier.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function intimacyOf(state, now, config) {
	const days = daysAlive(state, now, config.timezoneOffsetMinutes);
	const raw = state.totals.interactions * 1.5 + state.totals.meals * 0.4 + days * 2;
	const score = clamp(Math.round(raw), 0, 100);
	let level = INTIMACY_LEVELS[0];
	for (const candidate of INTIMACY_LEVELS) if (score >= candidate.min) level = candidate;
	const next = INTIMACY_LEVELS.find((candidate) => candidate.min > score) ?? null;
	return {
		score,
		title: level.title,
		emoji: level.emoji,
		nextTitle: next?.title ?? null,
		nextAt: next?.min ?? null,
	};
}

/**
 * Mood score (0–100) and the matching tier. Recent meals and chats cheer the
 * fish up; a long silence between meals makes it hungry.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function moodOf(state, now, config) {
	const today = todayStats(state, now, config);
	const hoursSinceMeal = state.lastMealAt == null ? 24 : Math.max(0, (now - state.lastMealAt) / 3_600_000);
	const streakBonus = Math.min(12, state.streak.days * 2);
	const score = clamp(
		Math.round(18 + today.meals * 18 + today.interactions * 5 + streakBonus - hoursSinceMeal * 2.5),
		0,
		100,
	);
	const tier = MOOD_LEVELS.find((candidate) => score <= candidate.max) ?? MOOD_LEVELS[MOOD_LEVELS.length - 1];
	return {
		score,
		key: tier.key,
		label: tier.label,
		emoji: tier.emoji,
		face: tier.face,
		hoursSinceMeal: Math.round(hoursSinceMeal * 10) / 10,
	};
}

/**
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function summaryOf(state, now, config) {
	const today = todayStats(state, now, config);
	const mood = moodOf(state, now, config);
	const intimacy = intimacyOf(state, now, config);
	return {
		now,
		fishName: state.fishName,
		daysAlive: daysAlive(state, now, config.timezoneOffsetMinutes),
		coins: state.coins,
		costCNY: state.totals.costCNY,
		meals: state.totals.meals,
		interactions: state.totals.interactions,
		tokens: { ...state.totals.tokens },
		today,
		streakDays: state.streak.days,
		mood,
		intimacy,
	};
}

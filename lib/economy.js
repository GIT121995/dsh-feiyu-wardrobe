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
 * M5 interaction rules (pat / feed / daily greet). All caps are enforced by the
 * host (`canInteract`) so failures never mutate state; the page mirrors the
 * returned `allowed`/`retryInMs` for UX only.
 */
export const INTERACTION_RULES = {
	pat: { cooldownMs: 20_000, dailyMax: 12, mood: 2, moodDailyCap: 12, intimacy: 0.2 },
	feed: {
		cooldownMs: 45_000,
		dailyMax: 3,
		moodDailyCap: 18,
		tiers: {
			small: { coins: 3, mood: 8, intimacy: 0.5, label: '小鱼干' },
			big: { coins: 8, mood: 16, intimacy: 1.2, label: '大餐' },
		},
	},
	greet: { mood: 4, intimacy: 0.5 },
	/** mood score >= this refuses feeding (already stuffed). */
	feedBlockMoodScore: 95,
};
/** Cap for the lifetime interaction contribution to the intimacy score. */
export const INTERACTION_INTIMACY_CAP = 10;

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
 * Ensure the interactions ledger exists (old / hand-edited state safety net).
 * @param {import('./state.js').FishState} state
 */
export function ensureInteractions(state) {
	if (!state.interactions || typeof state.interactions !== 'object') {
		state.interactions = {
			lifetime: { pats: 0, feeds: 0, greets: 0, coinsSpent: 0 },
			last: { patAt: null, feedAt: null, greetDay: null },
			daily: {},
		};
	}
	const it = state.interactions;
	if (!it.lifetime || typeof it.lifetime !== 'object') it.lifetime = { pats: 0, feeds: 0, greets: 0, coinsSpent: 0 };
	if (!it.last || typeof it.last !== 'object') it.last = { patAt: null, feedAt: null, greetDay: null };
	if (!it.daily || typeof it.daily !== 'object') it.daily = {};
	return it;
}

/**
 * Today's interaction counters (zeros when the day has no row yet).
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function todayInteractions(state, now, config) {
	ensureInteractions(state);
	const key = dayKey(now, config.timezoneOffsetMinutes);
	const row = state.interactions.daily[key];
	return row ? { ...row } : { pats: 0, feeds: 0, greets: 0, coinsSpent: 0 };
}

/**
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
function touchInteractionDay(state, now, config) {
	ensureInteractions(state);
	const key = dayKey(now, config.timezoneOffsetMinutes);
	return (state.interactions.daily[key] ??= { pats: 0, feeds: 0, greets: 0, coinsSpent: 0 });
}

/**
 * @param {number} now
 * @param {number | null} at
 * @param {number} cooldownMs
 */
function cooldownLeft(now, at, cooldownMs) {
	if (typeof at !== 'number' || !Number.isFinite(at)) return 0;
	return Math.max(0, Math.round(at + cooldownMs - now));
}

/**
 * Check whether an interaction is currently allowed (read-only, no mutation).
 * @param {import('./state.js').FishState} state
 * @param {'pat'|'feed'|'greet'} kind
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 * @param {'small'|'big'} [tier]
 * @returns {{ ok: boolean, reason?: string, retryInMs?: number, cost?: number, dailyLeft?: number }}
 */
export function canInteract(state, kind, now, config, tier = 'small') {
	const dressUp = /** @type {any} */ (config).dressUp;
	if (dressUp && dressUp.interaction && dressUp.interaction.enabled === false) {
		return { ok: false, reason: 'disabled' };
	}
	ensureInteractions(state);
	const rules = INTERACTION_RULES;
	if (kind === 'pat') {
		const left = cooldownLeft(now, state.interactions.last.patAt, rules.pat.cooldownMs);
		if (left > 0) return { ok: false, reason: 'cooldown', retryInMs: left };
		const today = todayInteractions(state, now, config);
		if (today.pats >= rules.pat.dailyMax) return { ok: false, reason: 'daily-cap' };
		return { ok: true, dailyLeft: rules.pat.dailyMax - today.pats };
	}
	if (kind === 'feed') {
		const tierRule = rules.feed.tiers[tier];
		if (!tierRule) return { ok: false, reason: 'bad-kind' };
		const left = cooldownLeft(now, state.interactions.last.feedAt, rules.feed.cooldownMs);
		if (left > 0) return { ok: false, reason: 'cooldown', retryInMs: left };
		const today = todayInteractions(state, now, config);
		if (today.feeds >= rules.feed.dailyMax) return { ok: false, reason: 'daily-cap' };
		if (state.coins < tierRule.coins) return { ok: false, reason: 'no-coins', cost: tierRule.coins };
		if (moodOf(state, now, config).score >= rules.feedBlockMoodScore) return { ok: false, reason: 'full' };
		return { ok: true, cost: tierRule.coins, dailyLeft: rules.feed.dailyMax - today.feeds };
	}
	if (kind === 'greet') {
		const key = dayKey(now, config.timezoneOffsetMinutes);
		if (state.interactions.last.greetDay === key) return { ok: false, reason: 'daily-cap' };
		return { ok: true };
	}
	return { ok: false, reason: 'bad-kind' };
}

/**
 * Pat the fish (free); caller must have a passing `canInteract`.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function applyPat(state, now, config) {
	ensureInteractions(state);
	const today = touchInteractionDay(state, now, config);
	state.interactions.lifetime.pats += 1;
	state.interactions.last.patAt = now;
	today.pats += 1;
	state.lastActiveAt = now;
	bumpStreak(state, now, config);
	return { ok: true, kind: 'pat', pats: state.interactions.lifetime.pats };
}

/**
 * Feed the fish with fish-food coins; caller must have a passing `canInteract`.
 * Deducts synchronously (no await) -> no double-spend inside one host process.
 * @param {import('./state.js').FishState} state
 * @param {'small'|'big'} tier
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function applyFeed(state, tier, now, config) {
	const tierRule = INTERACTION_RULES.feed.tiers[tier];
	ensureInteractions(state);
	const today = touchInteractionDay(state, now, config);
	state.coins = round(state.coins - tierRule.coins, 4);
	state.totals.coinsSpent = round((state.totals.coinsSpent || 0) + tierRule.coins, 4);
	state.interactions.lifetime.feeds += 1;
	state.interactions.lifetime.coinsSpent = round(state.interactions.lifetime.coinsSpent + tierRule.coins, 4);
	state.interactions.last.feedAt = now;
	state.lastMealAt = now; // feeding counts as a meal for the mood decay clock
	state.lastActiveAt = now;
	today.feeds += 1;
	today.coinsSpent = round(today.coinsSpent + tierRule.coins, 4);
	bumpStreak(state, now, config);
	return { ok: true, kind: 'feed', tier, cost: tierRule.coins, feeds: state.interactions.lifetime.feeds };
}

/**
 * Once-per-day greeting (free); caller must have a passing `canInteract`.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function applyGreet(state, now, config) {
	ensureInteractions(state);
	const today = touchInteractionDay(state, now, config);
	state.interactions.lifetime.greets += 1;
	state.interactions.last.greetDay = dayKey(now, config.timezoneOffsetMinutes);
	state.lastActiveAt = now;
	today.greets += 1;
	bumpStreak(state, now, config);
	return { ok: true, kind: 'greet', greets: state.interactions.lifetime.greets };
}

/**
 * Aggregated interaction summary for the page / pet GET endpoint. No line text.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function interactionSummary(state, now, config) {
	ensureInteractions(state);
	const today = todayInteractions(state, now, config);
	const key = dayKey(now, config.timezoneOffsetMinutes);
	const mood = moodOf(state, now, config);
	const intimacy = intimacyOf(state, now, config);
	const pat = canInteract(state, 'pat', now, config);
	const feedSmall = canInteract(state, 'feed', now, config, 'small');
	const feedBig = canInteract(state, 'feed', now, config, 'big');
	const greet = canInteract(state, 'greet', now, config);
	const dressUp = /** @type {any} */ (config).dressUp;
	return {
		enabled: !(dressUp && dressUp.interaction && dressUp.interaction.enabled === false),
		coins: state.coins,
		mood: { score: mood.score, key: mood.key, label: mood.label, emoji: mood.emoji, face: mood.face },
		intimacy,
		streakDays: state.streak.days,
		today: { meals: todayStats(state, now, config).meals, ...today },
		allowed: { pat: pat.ok, feedSmall: feedSmall.ok, feedBig: feedBig.ok, greet: greet.ok },
		retryIn: { pat: pat.retryInMs || 0, feed: Math.max(feedSmall.retryInMs || 0, feedBig.retryInMs || 0) },
		reasons: {
			pat: pat.reason || '',
			feedSmall: feedSmall.reason || '',
			feedBig: feedBig.reason || '',
			greet: greet.reason || '',
		},
		greetedToday: state.interactions.last.greetDay === key,
		costs: { small: INTERACTION_RULES.feed.tiers.small.coins, big: INTERACTION_RULES.feed.tiers.big.coins },
		limits: { patDailyMax: INTERACTION_RULES.pat.dailyMax, feedDailyMax: INTERACTION_RULES.feed.dailyMax },
	};
}

/**
 * Intimacy score (0–100) and the matching tier./**
 * Intimacy score (0–100) and the matching tier.
 * @param {import('./state.js').FishState} state
 * @param {number} now
 * @param {import('./config.js').FeiyuConfig} config
 */
export function intimacyOf(state, now, config) {
	const days = daysAlive(state, now, config.timezoneOffsetMinutes);
	ensureInteractions(state);
	const it = state.interactions.lifetime;
	const interactionBonus = Math.min(
		INTERACTION_INTIMACY_CAP,
		it.pats * INTERACTION_RULES.pat.intimacy +
			it.feeds * INTERACTION_RULES.feed.tiers.small.intimacy +
			it.greets * INTERACTION_RULES.greet.intimacy,
	);
	const raw = state.totals.interactions * 1.5 + state.totals.meals * 0.4 + days * 2 + interactionBonus;
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
	const it = todayInteractions(state, now, config);
	const patBonus = Math.min(INTERACTION_RULES.pat.moodDailyCap, it.pats * INTERACTION_RULES.pat.mood);
	const feedBonus = Math.min(INTERACTION_RULES.feed.moodDailyCap, it.feeds * INTERACTION_RULES.feed.tiers.small.mood);
	const greetBonus = it.greets > 0 ? INTERACTION_RULES.greet.mood : 0;
	const score = clamp(
		Math.round(
			18 + today.meals * 18 + today.interactions * 5 + streakBonus - hoursSinceMeal * 2.5 +
				patBonus + feedBonus + greetBonus,
		),
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
		interactionState: interactionSummary(state, now, config),
	};
}

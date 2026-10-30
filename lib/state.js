/**
 * Persistent fish state: schema, normalization, load/save and day pruning.
 *
 * The state file is the durable source of truth for the wardrobe. It holds
 * aggregates only — no message text, no model output — so the report card can
 * be shared without leaking a conversation.
 * @module dsh-feiyu-wardrobe/state
 */

import { existsSync } from 'node:fs';
import { atomicWriteJson, dayKey, readJsonFile } from './util.js';
import { ITEM_BY_ID, STARTER_ITEMS } from './catalog.js';

export const STATE_VERSION = 1;
export const MAX_SESSIONS = 200;

/**
 * @typedef {object} DayStats
 * @property {number} costCNY
 * @property {number} meals
 * @property {number} interactions
 */

/**
 * @typedef {object} FishState
 * @property {number} version
 * @property {string} fishName
 * @property {number} bornAt
 * @property {number} lastActiveAt
 * @property {number | null} lastMealAt
 * @property {{ costCNY: number, coinsEarned: number, meals: number, interactions: number, turns: number, tokens: { input: number, cacheRead: number, cacheWrite: number, output: number, total: number } }} totals
 * @property {number} coins
 * @property {string[]} sessions
 * @property {Record<string, DayStats>} daily
 * @property {{ lastDay: string | null, days: number }} streak
 * @property {Record<string, string>} equipped
 * @property {string[]} owned
 * @property {number} updatedAt
 */

/**
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} [now]
 * @returns {FishState}
 */
export function createState(config, now = Date.now()) {
	return {
		version: STATE_VERSION,
		fishName: config.fishName,
		bornAt: now,
		lastActiveAt: now,
		lastMealAt: null,
		totals: {
			costCNY: 0,
			coinsEarned: 0,
			meals: 0,
			interactions: 0,
			turns: 0,
			tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
		},
		coins: config.birthGiftCoins,
		sessions: [],
		daily: {},
		streak: { lastDay: null, days: 0 },
		equipped: {},
		owned: [...STARTER_ITEMS],
		updatedAt: now,
	};
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function finite(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function nonNegative(value, fallback = 0) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Merge a persisted (possibly old or hand-edited) state into the current schema.
 * @param {any} raw
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} now
 * @returns {FishState}
 */
export function normalizeState(raw, config, now = Date.now()) {
	const fallback = createState(config, now);
	if (!raw || typeof raw !== 'object') return fallback;
	const totals = raw.totals && typeof raw.totals === 'object' ? raw.totals : {};
	const tokens = totals.tokens && typeof totals.tokens === 'object' ? totals.tokens : {};
	const owned = new Set(Array.isArray(raw.owned) ? raw.owned.filter((id) => typeof id === 'string') : []);
	for (const id of fallback.owned) owned.add(id);
	/** @type {Record<string, string>} */
	const equipped = {};
	if (raw.equipped && typeof raw.equipped === 'object') {
		for (const [slot, id] of Object.entries(raw.equipped)) {
			if (typeof slot !== 'string' || typeof id !== 'string') continue;
			const item = ITEM_BY_ID.get(id);
			if (item && item.slot === slot && owned.has(id)) equipped[slot] = id;
		}
	}
	/** @type {Record<string, DayStats>} */
	const daily = {};
	if (raw.daily && typeof raw.daily === 'object') {
		for (const [day, stats] of Object.entries(raw.daily)) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !stats || typeof stats !== 'object') continue;
			daily[day] = {
				costCNY: nonNegative(/** @type {any} */ (stats).costCNY),
				meals: Math.floor(nonNegative(/** @type {any} */ (stats).meals)),
				interactions: Math.floor(nonNegative(/** @type {any} */ (stats).interactions)),
			};
		}
	}
	const sessions = Array.isArray(raw.sessions)
		? raw.sessions.filter((id) => typeof id === 'string').slice(-MAX_SESSIONS)
		: [];
	const streakRaw = raw.streak && typeof raw.streak === 'object' ? raw.streak : {};
	const streakDay =
		typeof streakRaw.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(streakRaw.lastDay)
			? streakRaw.lastDay
			: null;
	const username =
		typeof raw.fishName === 'string' && raw.fishName.trim().length > 0
			? raw.fishName.trim().slice(0, 40)
			: config.fishName;
	const bornAt = nonNegative(raw.bornAt, now) || now;
	return {
		version: STATE_VERSION,
		fishName: username,
		bornAt,
		lastActiveAt: nonNegative(raw.lastActiveAt, bornAt),
		lastMealAt: typeof raw.lastMealAt === 'number' && Number.isFinite(raw.lastMealAt) ? raw.lastMealAt : null,
		totals: {
			costCNY: nonNegative(totals.costCNY),
			coinsEarned: nonNegative(totals.coinsEarned),
			meals: Math.floor(nonNegative(totals.meals)),
			interactions: Math.floor(nonNegative(totals.interactions)),
			turns: Math.floor(nonNegative(totals.turns)),
			tokens: {
				input: Math.floor(nonNegative(tokens.input)),
				cacheRead: Math.floor(nonNegative(tokens.cacheRead)),
				cacheWrite: Math.floor(nonNegative(tokens.cacheWrite)),
				output: Math.floor(nonNegative(tokens.output)),
				total: Math.floor(nonNegative(tokens.total)),
			},
		},
		coins: nonNegative(raw.coins, config.birthGiftCoins),
		sessions,
		daily,
		streak: {
			lastDay: streakDay,
			days: streakDay ? Math.floor(nonNegative(streakRaw.days)) : 0,
		},
		equipped,
		owned: [...owned],
		updatedAt: finite(raw.updatedAt) || now,
	};
}

/**
 * Load state from disk, creating a fresh fish when the file is missing.
 * @param {string} path
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} [now]
 * @returns {{ state: FishState, isNew: boolean }}
 */
export function loadState(path, config, now = Date.now()) {
	if (!existsSync(path)) {
		const state = createState(config, now);
		return { state, isNew: true };
	}
	return { state: normalizeState(readJsonFile(path, null), config, now), isNew: false };
}

/**
 * Persist state atomically.
 * @param {string} path
 * @param {FishState} state
 * @param {number} [now]
 * @returns {FishState}
 */
export function saveState(path, state, now = Date.now()) {
	state.updatedAt = now;
	atomicWriteJson(path, state);
	return state;
}

/**
 * Drop daily rows older than the retention window (keeps the file bounded and
 * the report honest).
 * @param {FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} [now]
 * @returns {number} removed rows
 */
export function pruneDaily(state, config, now = Date.now()) {
	const keys = Object.keys(state.daily).sort();
	const keep = Math.max(1, config.dailyRetentionDays);
	if (keys.length <= keep) return 0;
	const cutoff = keys[keys.length - keep];
	let removed = 0;
	for (const key of keys) {
		if (key < cutoff) {
			delete state.daily[key];
			removed += 1;
		}
	}
	return removed;
}

/**
 * Insert a session id into the bounded known-session list.
 * @param {FishState} state
 * @param {string} sessionId
 * @returns {boolean} true when the session was new
 */
export function touchSession(state, sessionId) {
	const id = String(sessionId ?? '').trim();
	if (id.length === 0) return false;
	if (state.sessions.includes(id)) return false;
	state.sessions.push(id);
	if (state.sessions.length > MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS);
	return true;
}

/**
 * Number of calendar days the fish has been alive (minimum 1).
 * @param {FishState} state
 * @param {number} now
 * @param {number} [timezoneOffsetMinutes]
 * @returns {number}
 */
export function daysAlive(state, now, timezoneOffsetMinutes = 480) {
	const born = dayKey(state.bornAt, timezoneOffsetMinutes);
	const today = dayKey(now, timezoneOffsetMinutes);
	const [by, bm, bd] = born.split('-').map(Number);
	const [ty, tm, td] = today.split('-').map(Number);
	const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
	return Math.max(1, diff + 1);
}

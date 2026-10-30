/**
 * Wardrobe plugin configuration: defaults, validation and path resolution.
 * Unknown keys are ignored on purpose so patch files stay forward-compatible.
 * @module dsh-feiyu-wardrobe/config
 */

import { expandHome, defaultStatePath } from './util.js';

export const DEFAULT_FISH_NAME = '大肥鱼';
export const DEFAULT_COIN_PER_CNY = 100;
export const DEFAULT_BIRTH_GIFT_COINS = 120;
export const DEFAULT_DAILY_RETENTION_DAYS = 120;

/**
 * @typedef {object} FeiyuConfig
 * @property {string} fishName
 * @property {string} statePath
 * @property {number} timezoneOffsetMinutes
 * @property {number} coinPerCNY
 * @property {number} birthGiftCoins
 * @property {number} dailyRetentionDays
 * @property {string[]} holidays
 * @property {Record<string, { cacheHitInput: number, cacheMissInput: number, output: number, cacheWriteInput?: number }> | null} prices
 */

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {FeiyuConfig}
 */
export function validateConfig(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const fishName =
		typeof source.fishName === 'string' && source.fishName.trim().length > 0
			? source.fishName.trim().slice(0, 40)
			: DEFAULT_FISH_NAME;
	const statePath =
		typeof source.statePath === 'string' && source.statePath.trim().length > 0
			? expandHome(source.statePath.trim())
			: defaultStatePath();
	const timezoneOffsetMinutes = Number.isFinite(source.timezoneOffsetMinutes)
		? Number(source.timezoneOffsetMinutes)
		: 480;
	const coinPerCNY =
		Number.isFinite(source.coinPerCNY) && Number(source.coinPerCNY) > 0
			? Number(source.coinPerCNY)
			: DEFAULT_COIN_PER_CNY;
	const birthGiftCoins =
		Number.isFinite(source.birthGiftCoins) && Number(source.birthGiftCoins) >= 0
			? Number(source.birthGiftCoins)
			: DEFAULT_BIRTH_GIFT_COINS;
	const dailyRetentionDays =
		Number.isFinite(source.dailyRetentionDays) && Number(source.dailyRetentionDays) >= 1
			? Math.floor(Number(source.dailyRetentionDays))
			: DEFAULT_DAILY_RETENTION_DAYS;
	const holidays = Array.isArray(source.holidays)
		? source.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
		: [];
	const prices =
		source.prices && typeof source.prices === 'object'
			? /** @type {any} */ (source.prices)
			: null;
	return {
		fishName,
		statePath,
		timezoneOffsetMinutes,
		coinPerCNY,
		birthGiftCoins,
		dailyRetentionDays,
		holidays,
		prices,
	};
}

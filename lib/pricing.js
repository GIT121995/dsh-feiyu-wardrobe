/**
 * DeepSeek API pricing and Asia/Shanghai peak/off-peak helpers.
 *
 * Prices are CNY per 1,000,000 tokens, off-peak, from the official page
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing, fetched 2026-10-21).
 * Peak price = off-peak price × peakMultiplier (official ratio is 2×).
 *
 * Peak windows (Asia/Shanghai, Monday–Friday, statutory holidays excluded):
 * 09:00–12:00 and 14:00–18:00. Weekends and configured holidays are off-peak.
 *
 * TokenUsage semantics (verified against persisted `assistant/message` events):
 *   inputTokens      - cache-miss input tokens (billed at the miss price)
 *   cacheReadTokens  - cache-hit input tokens (billed at the hit price)
 *   cacheWriteTokens - cache-write tokens (billed at the miss price when > 0)
 *   outputTokens     - completion tokens
 * @module dsh-feiyu-wardrobe/pricing
 */

export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 480;
export const DEFAULT_PEAK_MULTIPLIER = 2;
export const DEFAULT_MODEL = 'deepseek-flash';

export const DEFAULT_PRICES = Object.freeze({
	'deepseek-flash': Object.freeze({ cacheHitInput: 0.02, cacheMissInput: 1, output: 4 }),
	'deepseek-v4-pro': Object.freeze({ cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 }),
});

const MODEL_ALIASES = new Map([
	['deepseek-flash', 'deepseek-flash'],
	['deepseek-v4-flash', 'deepseek-flash'],
	['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
	['deepseek-v4-pro', 'deepseek-v4-pro'],
	['deepseek-pro', 'deepseek-v4-pro'],
]);

/**
 * Map model aliases to a canonical pricing key.
 * @param {unknown} model
 * @returns {string | null}
 */
export function canonicalModel(model) {
	if (typeof model !== 'string') return null;
	const value = model.trim().toLowerCase();
	if (value.length === 0) return null;
	return MODEL_ALIASES.get(value) ?? value;
}

/**
 * Beijing wall-clock parts for an epoch-ms timestamp.
 * @param {number} timeMs
 * @param {number} [timezoneOffsetMinutes]
 */
export function beijingParts(timeMs, timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
	const shifted = new Date(Number(timeMs) + timezoneOffsetMinutes * 60_000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
	const day = String(shifted.getUTCDate()).padStart(2, '0');
	return {
		date: `${year}-${month}-${day}`,
		weekday: shifted.getUTCDay(),
		minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
	};
}

/**
 * @param {number} timeMs
 * @param {{ timezoneOffsetMinutes?: number, holidays?: string[] }} [options]
 * @returns {boolean}
 */
export function isPeak(timeMs, options = {}) {
	const timezoneOffsetMinutes = options.timezoneOffsetMinutes ?? DEFAULT_TIMEZONE_OFFSET_MINUTES;
	const { date, weekday, minutes } = beijingParts(timeMs, timezoneOffsetMinutes);
	if (weekday === 0 || weekday === 6) return false;
	if (Array.isArray(options.holidays) && options.holidays.includes(date)) return false;
	return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function positive(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normalize a harness TokenUsage record into billed buckets.
 * @param {Record<string, unknown> | null | undefined} usage
 */
export function normalizeUsage(usage) {
	const cacheHitInput = positive(usage?.cacheReadTokens);
	const cacheMissInput = positive(usage?.inputTokens);
	const cacheWriteInput = positive(usage?.cacheWriteTokens);
	const output = positive(usage?.outputTokens);
	const total = positive(usage?.totalTokens) || cacheHitInput + cacheMissInput + cacheWriteInput + output;
	return { cacheHitInput, cacheMissInput, cacheWriteInput, output, total };
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 6) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * Resolve the price row for a model; unknown models fall back to `defaultModel`.
 * @param {unknown} model
 * @param {Record<string, { cacheHitInput: number, cacheMissInput: number, output: number, cacheWriteInput?: number }>} [prices]
 * @param {string} [defaultModel]
 */
export function resolvePrice(model, prices = DEFAULT_PRICES, defaultModel = DEFAULT_MODEL) {
	const table = { ...DEFAULT_PRICES, ...(prices ?? {}) };
	const key = canonicalModel(model) ?? canonicalModel(defaultModel) ?? DEFAULT_MODEL;
	if (table[key]) return { model: key, prices: table[key], known: true };
	const fallbackKey = canonicalModel(defaultModel) ?? DEFAULT_MODEL;
	return { model: key, prices: /** @type {any} */ (table[fallbackKey] ?? DEFAULT_PRICES[fallbackKey]), known: false };
}

/**
 * Price one model call.
 * @param {{ cacheReadTokens?: number, inputTokens?: number, cacheWriteTokens?: number, outputTokens?: number, totalTokens?: number }} usage
 * @param {{
 *   model?: string | null,
 *   timeMs?: number,
 *   peak?: boolean,
 *   timezoneOffsetMinutes?: number,
 *   peakMultiplier?: number,
 *   prices?: Record<string, { cacheHitInput: number, cacheMissInput: number, output: number, cacheWriteInput?: number }>,
 *   defaultModel?: string,
 *   holidays?: string[],
 * }} [options]
 */
export function computeCost(usage, options = {}) {
	const normalized = normalizeUsage(usage);
	const peak = options.timeMs == null ? Boolean(options.peak) : isPeak(options.timeMs, options);
	const multiplier = peak ? (options.peakMultiplier ?? DEFAULT_PEAK_MULTIPLIER) : 1;
	const resolved = resolvePrice(options.model, options.prices, options.defaultModel ?? DEFAULT_MODEL);
	const price = resolved.prices;
	const cacheHitPrice = price.cacheHitInput * multiplier;
	const cacheMissPrice = price.cacheMissInput * multiplier;
	const cacheWritePrice = (price.cacheWriteInput ?? price.cacheMissInput) * multiplier;
	const outputPrice = price.output * multiplier;
	const cacheHitCost = (normalized.cacheHitInput * cacheHitPrice) / 1e6;
	const cacheMissCost = (normalized.cacheMissInput * cacheMissPrice) / 1e6;
	const cacheWriteCost = (normalized.cacheWriteInput * cacheWritePrice) / 1e6;
	const outputCost = (normalized.output * outputPrice) / 1e6;
	return {
		model: resolved.model,
		knownModel: resolved.known,
		peak,
		usage: normalized,
		breakdownCNY: {
			cacheHitInput: round(cacheHitCost),
			cacheMissInput: round(cacheMissCost),
			cacheWriteInput: round(cacheWriteCost),
			output: round(outputCost),
		},
		costCNY: round(cacheHitCost + cacheMissCost + cacheWriteCost + outputCost),
	};
}

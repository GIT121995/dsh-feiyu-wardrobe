/**
 * Wardrobe plugin configuration: defaults, validation and path resolution.
 * Unknown keys are ignored on purpose so patch files stay forward-compatible.
 * @module dsh-feiyu-wardrobe/config
 */

import { dirname, join } from 'node:path';

import { DEFAULT_DAILY_BUDGET_YUAN, DEFAULT_DAILY_IMAGE_LIMIT, DEFAULT_PRICE_PER_IMAGE_YUAN, defaultBaseRefPath } from './diy.js';
import { DEFAULT_DIY_MODEL, DEFAULT_DIY_SIZE } from './diy-provider.js';
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
 * @property {DiyConfig} diy DIY 上传（默认关闭；全部能力 opt-in）
 */

/**
 * @typedef {object} DiyConfig
 * @property {boolean} enabled 总开关（默认 false；关闭时路由只回 status、无任何网络调用）
 * @property {string} model Seedream 模型
 * @property {string} size 生成尺寸
 * @property {string} apiKeyFile 可选：ARK_API_KEY 的环境文件路径（宿主侧，空=~/.config/seedream/env）
 * @property {string} statePath 预算台账状态文件
 * @property {string} costLogPath 成本日志 JSONL
 * @property {string} cacheDir hash 去重缓存目录
 * @property {string} baseRefPath 素体参考图（宿主侧）
 * @property {number} pricePerImageYuan 单张图保守成本（¥，默认 0.30）
 * @property {number} dailyImageLimit 每日图片上限
 * @property {number} dailyBudgetYuan 每日金额上限（¥）
 * @property {number} retries 单张失败重试上限（≤2）
 * @property {number} timeoutMs 单张请求超时
 * @property {number} maxUploadBytes 上传图上限（解码后字节）
 * @property {number} cacheMaxEntries 缓存条目上限
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
	/** @type {DiyConfig} */
	const diy = validateDiyConfig(source.diy, statePath);
	return {
		fishName,
		statePath,
		timezoneOffsetMinutes,
		coinPerCNY,
		birthGiftCoins,
		dailyRetentionDays,
		holidays,
		prices,
		diy,
	};
}

/** DIY 默认数据目录（与 wardrobe state 同目录下）。 */
function defaultDiyDirFor(statePath) {
	return join(dirname(statePath), 'diy');
}

/**
 * 校验 DIY 配置（未知字段忽略；越界值收敛到安全区间；默认关闭）。
 * @param {unknown} raw
 * @param {string} statePath
 * @returns {DiyConfig}
 */
export function validateDiyConfig(raw, statePath) {
	const source = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
	const dir = defaultDiyDirFor(statePath);
	/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback @param {boolean} [integer] */
	const clampNumber = (value, min, max, fallback, integer = false) => {
		if (!Number.isFinite(value)) return fallback;
		const number = Math.min(max, Math.max(min, Number(value)));
		return integer ? Math.floor(number) : number;
	};
	const stringOr = (/** @type {unknown} */ value, /** @type {string} */ fallback) =>
		typeof value === 'string' && value.trim().length > 0 ? expandHome(value.trim()) : fallback;
	return {
		enabled: source.enabled === true,
		model: stringOr(source.model, DEFAULT_DIY_MODEL),
		size: stringOr(source.size, DEFAULT_DIY_SIZE),
		apiKeyFile: typeof source.apiKeyFile === 'string' ? expandHome(source.apiKeyFile.trim()) : '',
		statePath: stringOr(source.statePath, join(dir, 'ledger.json')),
		costLogPath: stringOr(source.costLogPath, join(dir, 'costs.jsonl')),
		cacheDir: stringOr(source.cacheDir, join(dir, 'cache')),
		baseRefPath: stringOr(source.baseRefPath, defaultBaseRefPath()),
		pricePerImageYuan: clampNumber(source.pricePerImageYuan, 0.01, 10, DEFAULT_PRICE_PER_IMAGE_YUAN),
		dailyImageLimit: clampNumber(source.dailyImageLimit, 1, 500, DEFAULT_DAILY_IMAGE_LIMIT, true),
		dailyBudgetYuan: clampNumber(source.dailyBudgetYuan, 0.1, 500, DEFAULT_DAILY_BUDGET_YUAN),
		retries: clampNumber(source.retries, 0, 2, 2, true),
		timeoutMs: clampNumber(source.timeoutMs, 30_000, 300_000, 180_000, true),
		maxUploadBytes: clampNumber(source.maxUploadBytes, 64 * 1024, 4 * 1024 * 1024, 4 * 1024 * 1024, true),
		cacheMaxEntries: clampNumber(source.cacheMaxEntries, 4, 400, 80, true),
	};
}

/**
 * dsh-feiyu-wardrobe — 大肥鱼衣橱
 *
 * A chubby-whale wardrobe economy for DeepSeek Harness: every token the agent
 * burns is fish food, every meal earns fish-food coins, and the coins unlock
 * original SVG outfits. Local-only: no extra model calls, no network, no chat
 * text stored.
 *
 * @module dsh-feiyu-wardrobe
 */

import { validateConfig } from './config.js';
import { findItem, ITEMS, ITEM_BY_ID, RARITIES, SLOTS, SLOT_ORDER, STARTER_ITEMS, itemsForSlot, rarityLabel, slotLabel } from './catalog.js';
import { applyInteraction, applyMeal, coinsForCost, INTIMACY_LEVELS, intimacyOf, MOOD_LEVELS, moodOf, summaryOf } from './economy.js';
import { attachHarness } from './harness.js';
import { computeCost } from './pricing.js';
import { renderCardHtml, renderWardrobeSheetHtml, sceneSvg, faceSvg } from './render.js';
import { defaultReportPath, writeReportCard } from './report.js';
import { WardrobeRuntime } from './runtime.js';
import { createState, loadState, normalizeState, saveState } from './state.js';
import { executeFishCommand, formatStatus, formatWardrobe, registerFishCommand } from './commands.js';
import { createDemoState } from './demo.js';

export const name = 'dsh-feiyu-wardrobe';
export const inject = ['commands'];

/**
 * Cordis plugin entry.
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
	const config = validateConfig(rawConfig);
	const logger =
		typeof ctx.logger === 'function'
			? ctx.logger('feiyu-wardrobe')
			: { info() {}, warn() {}, error() {} };
	let runtime;
	try {
		runtime = new WardrobeRuntime(config);
	} catch (cause) {
		logger.error(
			'wardrobe state unavailable; plugin disabled: %s',
			cause instanceof Error ? cause.message : String(cause),
		);
		return undefined;
	}
	try {
		attachHarness(ctx, runtime);
	} catch (cause) {
		logger.warn('fish command unavailable: %s', cause instanceof Error ? cause.message : String(cause));
	}
	logger.info('大肥鱼衣橱: state=%s', config.statePath);
	return runtime;
}

export {
	// catalog
	ITEMS,
	ITEM_BY_ID,
	RARITIES,
	SLOTS,
	SLOT_ORDER,
	STARTER_ITEMS,
	findItem,
	itemsForSlot,
	rarityLabel,
	slotLabel,
	// economy
	applyInteraction,
	applyMeal,
	coinsForCost,
	INTIMACY_LEVELS,
	intimacyOf,
	MOOD_LEVELS,
	moodOf,
	summaryOf,
	// pricing
	computeCost,
	// render / report
	renderCardHtml,
	renderWardrobeSheetHtml,
	sceneSvg,
	faceSvg,
	defaultReportPath,
	writeReportCard,
	// state / runtime
	WardrobeRuntime,
	createState,
	loadState,
	normalizeState,
	saveState,
	createDemoState,
	// commands
	executeFishCommand,
	formatStatus,
	formatWardrobe,
	registerFishCommand,
	validateConfig,
};

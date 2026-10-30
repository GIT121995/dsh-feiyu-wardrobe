/**
 * Runtime shared by the plugin and the report CLI: loads state once, turns
 * harness events into meals/interactions, and owns buy/wear/rename actions.
 * @module dsh-feiyu-wardrobe/runtime
 */

import { computeCost } from './pricing.js';
import { findItem, ITEM_BY_ID, SLOT_ORDER, STARTER_ITEMS } from './catalog.js';
import { applyInteraction, applyMeal, summaryOf } from './economy.js';
import { loadState, pruneDaily, saveState, touchSession } from './state.js';
import { isHumanUserMessage, round } from './util.js';

/**
 * @typedef {object} EventOutcome
 * @property {string} type
 * @property {number} [coins]
 * @property {number} [costCNY]
 */

export class WardrobeRuntime {
	/**
	 * @param {import('./config.js').FeiyuConfig} config
	 * @param {{ clock?: () => number }} [options]
	 */
	constructor(config, options = {}) {
		this.config = config;
		this.clock = options.clock ?? (() => Date.now());
		const loaded = loadState(config.statePath, config, this.clock());
		/** @type {import('./state.js').FishState} */
		this.state = loaded.state;
		/** @type {Map<string, string>} */
		this.modelBySession = new Map();
		this.isNew = loaded.isNew;
		if (this.isNew) this.save();
		else pruneDaily(this.state, config, this.clock());
	}

	/**
	 * @param {number} [now]
	 */
	save(now) {
		saveState(this.config.statePath, this.state, now ?? this.clock());
	}

	/**
	 * Feed one `session/event` through the economy. Never throws: a malformed
	 * event must not break the agent loop.
	 * @param {{ id?: string | number } | null | undefined} session
	 * @param {{ type?: string, time?: number, data?: any } | null | undefined} event
	 * @returns {EventOutcome | null}
	 */
	handleSessionEvent(session, event) {
		try {
			if (!event || typeof event.type !== 'string') return null;
			const now = this.clock();
			const sessionId = String(session?.id ?? 'unknown');
			touchSession(this.state, sessionId);

			if (event.type === 'request/header') {
				const header = event.data?.header ?? event.data;
				const config = header?.config ?? header;
				const model = config?.model;
				if (typeof model === 'string' && model.trim().length > 0) this.modelBySession.set(sessionId, model.trim());
				return null;
			}
			if (event.type === 'turn/start') {
				this.state.totals.turns += 1;
				this.state.lastActiveAt = now;
				this.save(now);
				return { type: 'turn' };
			}
			if (event.type === 'user/message') {
				if (!isHumanUserMessage(event.data)) return null;
				applyInteraction(this.state, now, this.config);
				this.save(now);
				return { type: 'interaction' };
			}
			if (event.type === 'assistant/message') {
				const usage = event.data?.usage;
				if (!usage || typeof usage !== 'object') return null;
				const model = this.modelBySession.get(sessionId) ?? null;
				const priced = computeCost(usage, {
					model,
					timeMs: typeof event.time === 'number' ? event.time : now,
					timezoneOffsetMinutes: this.config.timezoneOffsetMinutes,
					holidays: this.config.holidays,
					...(this.config.prices ? { prices: this.config.prices } : {}),
				});
				const gains = applyMeal(this.state, priced, now, this.config);
				this.save(now);
				return { type: 'meal', coins: gains.coins, costCNY: priced.costCNY };
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * @param {number} [now]
	 */
	status(now) {
		return summaryOf(this.state, now ?? this.clock(), this.config);
	}

	/**
	 * Equipped items in render order (background first).
	 * @returns {import('./catalog.js').Item[]}
	 */
	equippedItems() {
		/** @type {import('./catalog.js').Item[]} */
		const items = [];
		for (const slot of SLOT_ORDER) {
			const id = this.state.equipped[slot];
			const item = id ? ITEM_BY_ID.get(id) : null;
			if (item) items.push(item);
		}
		return items;
	}

	/**
	 * @returns {string}
	 */
	outfitLabel() {
		const names = this.equippedItems()
			.filter((item) => item.slot !== 'bg')
			.map((item) => item.name);
		return names.length > 0 ? names.join(' · ') : '素鱼一条';
	}

	/**
	 * Buy (and immediately wear) an item.
	 * @param {string} query
	 * @param {number} [now]
	 */
	buy(query, now = this.clock()) {
		const item = findItem(query);
		if (!item) return { ok: false, message: `衣柜里没有「${String(query).trim()}」这件，用 /fish list 看看。` };
		if (this.state.owned.includes(item.id)) {
			if (this.state.equipped[item.slot] !== item.id) {
				this.state.equipped[item.slot] = item.id;
				this.save(now);
				return { ok: true, message: `已经买过了，直接穿上「${item.name}」。` };
			}
			return { ok: true, message: `你正穿着「${item.name}」呢。` };
		}
		if (item.price > this.state.coins) {
			return {
				ok: false,
				message: `鱼粮币不够：${item.name} 要 ${item.price} 币，你现在有 ${Math.floor(this.state.coins)} 币。多烧点 token 吧。`,
			};
		}
		this.state.coins = round(this.state.coins - item.price, 4);
		this.state.owned.push(item.id);
		this.state.equipped[item.slot] = item.id;
		this.save(now);
		return { ok: true, message: `买到了「${item.name}」（-${item.price} 币），已自动穿上。` };
	}

	/**
	 * @param {string} query
	 * @param {number} [now]
	 */
	wear(query, now = this.clock()) {
		const item = findItem(query);
		if (!item) return { ok: false, message: `衣柜里没有「${String(query).trim()}」这件。` };
		if (!this.state.owned.includes(item.id)) {
			return { ok: false, message: `还没买「${item.name}」：${item.price} 币，用 /fish buy ${item.id}。` };
		}
		this.state.equipped[item.slot] = item.id;
		this.save(now);
		return { ok: true, message: `换上了「${item.name}」。` };
	}

	/**
	 * @param {string} slot
	 * @param {number} [now]
	 */
	takeOff(slot, now = this.clock()) {
		const normalized = String(slot ?? '').trim().toLowerCase();
		const entry = SLOT_ORDER.includes(/** @type {any} */ (normalized));
		if (!entry) return { ok: false, message: '用法：/fish takeoff <bg|body|neck|face|hand|hat>' };
		if (!this.state.equipped[normalized]) return { ok: true, message: '这个部位本来就没穿东西。' };
		delete this.state.equipped[normalized];
		this.save(now);
		return { ok: true, message: '脱下了。' };
	}

	/**
	 * @param {string} name
	 * @param {number} [now]
	 */
	rename(name, now = this.clock()) {
		const value = String(name ?? '').trim();
		if (value.length === 0) return { ok: false, message: '用法：/fish rename <名字>' };
		if (value.length > 20) return { ok: false, message: '名字太长，鱼记不住（最多 20 字）。' };
		this.state.fishName = value;
		this.save(now);
		return { ok: true, message: `这条鱼现在叫「${value}」。` };
	}
}

export { STARTER_ITEMS };

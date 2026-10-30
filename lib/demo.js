/**
 * A plausible demo state used by `dsh-feiyu-report --demo`, the screenshot
 * script and the tests, so the card can be previewed before a real fish has
 * eaten anything.
 * @module dsh-feiyu-wardrobe/demo
 */

import { createState } from './state.js';
import { dayKey, round } from './util.js';

/**
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} [now]
 * @returns {import('./state.js').FishState}
 */
export function createDemoState(config, now = Date.now()) {
	const twelveDays = 12 * 86_400_000;
	const state = createState(config, now - twelveDays);
	state.fishName = '干饭鲸';
	state.bornAt = now - twelveDays;
	state.lastActiveAt = now - 60_000;
	state.lastMealAt = now - 20 * 60_000;
	state.totals = {
		costCNY: 2.4381,
		coinsEarned: 243.81,
		meals: 30,
		interactions: 12,
		turns: 9,
		tokens: {
			input: 812_400,
			cacheRead: 1_930_500,
			cacheWrite: 0,
			output: 168_300,
			total: 2_911_200,
		},
	};
	state.coins = 187.5;
	state.sessions = ['demo-session-a', 'demo-session-b'];
	state.streak = { lastDay: dayKey(now, config.timezoneOffsetMinutes), days: 5 };
	state.owned = ['hat-leaf', 'neck-scarf', 'body-apron', 'hand-bowl', 'bg-tank', 'hat-straw', 'face-glasses'];
	state.equipped = {
		bg: 'bg-tank',
		body: 'body-apron',
		neck: 'neck-scarf',
		face: 'face-glasses',
		hand: 'hand-bowl',
		hat: 'hat-straw',
	};
	const pattern = [0.14, 0.22, 0.09, 0.31, 0.18, 0.12, 0.26, 0.08, 0.19, 0.34, 0.11, 0.16, 0.23, 0.068];
	for (let offset = pattern.length - 1; offset >= 0; offset -= 1) {
		const day = dayKey(now - offset * 86_400_000, config.timezoneOffsetMinutes);
		const cost = pattern[pattern.length - 1 - offset];
		state.daily[day] = {
			costCNY: round(cost, 6),
			meals: offset === 0 ? 2 : Math.max(1, Math.round(cost * 10)),
			interactions: offset === 0 ? 2 : Math.max(0, Math.round(cost * 6)),
		};
	}
	return state;
}

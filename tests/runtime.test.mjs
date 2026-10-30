import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import { registerFishCommand } from '../lib/commands.js';
import { WardrobeRuntime } from '../lib/runtime.js';

const NOW = Date.parse('2026-10-30T05:00:00Z'); // Friday 13:00 Beijing → off-peak
const PEAK = Date.parse('2026-10-30T02:30:00Z'); // Friday 10:30 Beijing → peak

function makeRuntime(now = NOW) {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-runtime-'));
	const config = validateConfig({ statePath: join(dir, 'state.json'), fishName: '测试鱼' });
	const runtime = new WardrobeRuntime(config, { clock: () => now });
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { runtime, config, dir, cleanup };
}

test('a runtime persists the newborn state immediately', () => {
	const { runtime, config, dir, cleanup } = makeRuntime();
	try {
		assert.equal(runtime.state.fishName, '测试鱼');
		assert.equal(runtime.state.coins, config.birthGiftCoins);
		const again = new WardrobeRuntime(config, { clock: () => NOW });
		assert.equal(again.state.owned.length, 1);
	} finally {
		cleanup();
	}
});

test('session events feed the economy and are persisted', () => {
	const { runtime, config, cleanup } = makeRuntime();
	try {
		assert.equal(runtime.handleSessionEvent({ id: 's1' }, { type: 'request/header', data: { header: { config: { model: 'deepseek-flash' } } } }), null);
		const meal = runtime.handleSessionEvent(
			{ id: 's1' },
			{ type: 'assistant/message', time: NOW, data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
		);
		assert.equal(meal.type, 'meal');
		assert.equal(meal.costCNY, 1);
		assert.equal(meal.coins, 100);
		assert.equal(runtime.state.totals.meals, 1);
		assert.equal(runtime.state.coins, config.birthGiftCoins + 100);

		runtime.handleSessionEvent({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'hi' } });
		runtime.handleSessionEvent({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'plugin' }, content: 'recall' } });
		assert.equal(runtime.state.totals.interactions, 1, 'only human messages count');

		runtime.handleSessionEvent({ id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
		assert.equal(runtime.state.totals.turns, 1);

		const reloaded = new WardrobeRuntime(config, { clock: () => NOW });
		assert.equal(reloaded.state.totals.meals, 1);
		assert.equal(reloaded.state.totals.interactions, 1);
		assert.equal(reloaded.state.sessions.length, 1);
	} finally {
		cleanup();
	}
});

test('peak pricing produces more coins for the same usage', () => {
	const { runtime: day, cleanup: cleanDay } = makeRuntime();
	const { runtime: noon, cleanup: cleanNoon } = makeRuntime(PEAK);
	try {
		day.handleSessionEvent({ id: 's' }, { type: 'request/header', data: { model: 'deepseek-flash' } });
		noon.handleSessionEvent({ id: 's' }, { type: 'request/header', data: { model: 'deepseek-flash' } });
		const usage = { inputTokens: 1_000_000 };
		const offPeak = day.handleSessionEvent({ id: 's' }, { type: 'assistant/message', time: NOW, data: { usage } });
		const peak = noon.handleSessionEvent({ id: 's' }, { type: 'assistant/message', time: PEAK, data: { usage } });
		assert.equal(offPeak.costCNY, 1);
		assert.equal(peak.costCNY, 2);
	} finally {
		cleanDay();
		cleanNoon();
	}
});

test('malformed events are swallowed', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		assert.equal(runtime.handleSessionEvent(null, null), null);
		assert.equal(runtime.handleSessionEvent({ id: 's' }, { type: 'assistant/message', data: {} }), null);
		assert.equal(runtime.handleSessionEvent({ id: 's' }, { type: 'assistant/message', data: { usage: 'nope' } }), null);
		assert.equal(runtime.state.totals.meals, 0);
	} finally {
		cleanup();
	}
});

test('buy, wear, takeoff and rename mutate the wardrobe', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		runtime.state.coins = 200;
		const bought = runtime.buy('红围巾');
		assert.equal(bought.ok, true);
		assert.equal(runtime.state.coins, 100);
		assert.ok(runtime.state.owned.includes('neck-scarf'));
		assert.equal(runtime.state.equipped.neck, 'neck-scarf');

		const tooExpensive = runtime.buy('王冠');
		assert.equal(tooExpensive.ok, false);
		assert.match(tooExpensive.message, /鱼粮币不够/);

		const unowned = runtime.wear('圆框眼镜');
		assert.equal(unowned.ok, false);

		const worn = runtime.wear('小叶子');
		assert.equal(worn.ok, true);
		assert.equal(runtime.state.equipped.hat, 'hat-leaf');

		const removed = runtime.takeOff('hat');
		assert.equal(removed.ok, true);
		assert.equal(runtime.state.equipped.hat, undefined);

		const renamed = runtime.rename('鲸鲸');
		assert.equal(renamed.ok, true);
		assert.equal(runtime.state.fishName, '鲸鲸');
	} finally {
		cleanup();
	}
});

test('status and outfit label are command-ready', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		const summary = runtime.status(NOW);
		assert.equal(summary.fishName, '测试鱼');
		assert.ok(summary.coins > 0);
		assert.equal(runtime.outfitLabel(), '素鱼一条');
	} finally {
		cleanup();
	}
});

test('/fish command is registered and serves status', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		/** @type {any} */
		let definition = null;
		const commands = {
			register(/** @type {any} */ created) {
				definition = created;
				return () => undefined;
			},
		};
		registerFishCommand(commands, runtime);
		assert.equal(definition.name, 'fish');
		const result = definition.handler({ rawInput: '' });
		assert.equal(result.kind, 'success');
		assert.match(result.text, /测试鱼/);
		assert.match(result.text, /鱼粮币/);
	} finally {
		cleanup();
	}
});
